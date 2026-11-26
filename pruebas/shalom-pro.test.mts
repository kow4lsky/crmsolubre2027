/**
 * Shalom PRO: el registro masivo y los estados, contra un Shalom falso que
 * responde como su web (sobre { success, message, data }, cookies de Laravel).
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { ClienteShalomPro, SesionVencida, dnisNoRegistrados, historial, rastreo, registrarMasivo } from "../src/lib/shalom-pro.ts";
import {
  cookieDeSesion,
  emparejarPorDni,
  estadoCrmDesdeShalom,
  etiquetaShalom,
  leerEnvioShalom,
  ordenDelTracking,
  trackingShalom,
} from "../src/lib/shalom-envios.ts";

test("lee la cookie de sesión como venga pegada", () => {
  assert.equal(cookieDeSesion("eyJpdiI6IkFCQyJ9"), "enviashalom_session=eyJpdiI6IkFCQyJ9");
  assert.equal(cookieDeSesion("enviashalom_session=eyJ9"), "enviashalom_session=eyJ9");
  assert.equal(cookieDeSesion("XSRF-TOKEN=x; remember_web_abc123=eyJ9; enviashalom_session=s"), "remember_web_abc123=eyJ9; enviashalom_session=s");
  assert.equal(cookieDeSesion("  "), null);
  assert.equal(cookieDeSesion("hola mundo"), null);
});

test("traduce un envío de Shalom y su estado", () => {
  const e = leerEnvioShalom({ service_order_id_empresarial: 103397868, code_service_order_empresarial: "3PCT", recipient_dni: "48419937", status: "en_destino", price: "12.00" });
  assert.deepEqual(e, { orden: "103397868", codigo: "3PCT", dni: "48419937", estado: "en_destino", costo: 12, destino: "" });
  assert.equal(trackingShalom(e), "103397868 - 3PCT");
  assert.equal(ordenDelTracking("103397868 - 3PCT"), "103397868");
  assert.equal(ordenDelTracking("3034861-26"), "3034861");
  assert.equal(ordenDelTracking(null), null);
  assert.equal(etiquetaShalom("en_destino"), "EN DESTINO");
});

test("el estado del CRM sólo avanza", () => {
  assert.equal(estadoCrmDesdeShalom("en_origen", "CONFIRMADO"), null);
  assert.equal(estadoCrmDesdeShalom("en_transito", "CONFIRMADO"), "EN TRÁNSITO");
  assert.equal(estadoCrmDesdeShalom("en_reparto", "CONFIRMADO"), "EN TRÁNSITO");
  assert.equal(estadoCrmDesdeShalom("en_destino", "EN TRÁNSITO"), "EN OFICINA");
  assert.equal(estadoCrmDesdeShalom("entregado", "EN OFICINA"), "ENTREGADO");
  assert.equal(estadoCrmDesdeShalom("en_transito", "EN OFICINA"), null);
  assert.equal(estadoCrmDesdeShalom("devuelto", "EN OFICINA"), "EN DEVOLUCIÓN");
  assert.equal(estadoCrmDesdeShalom("entregado", "ENTREGADO"), null);
  assert.equal(estadoCrmDesdeShalom("entregado", "RECHAZADO"), null);
  assert.equal(estadoCrmDesdeShalom("en_transito", "DEPURADO"), null);
});

test("empareja por DNI y, si se repite, se queda con la orden más nueva", () => {
  const envios = [
    leerEnvioShalom({ order_number: "100", code: "A", recipient_dni: "11111111" }),
    leerEnvioShalom({ order_number: "105", code: "B", recipient_dni: "11111111" }),
    leerEnvioShalom({ order_number: "101", code: "C", recipient_dni: "22222222" }),
  ];
  const m = emparejarPorDni([{ id: "p1", dni: "11111111" }, { id: "p2", dni: "33333333" }], envios);
  assert.equal(m.get("p1")?.orden, "105");
  assert.equal(m.has("p2"), false);
});

/** Un Shalom PRO falso: guarda borradores, exige la cookie y el XSRF. */
function shalomFalso() {
  const llamadas: string[] = [];
  let borradores: { id: number; error?: string }[] = []; // vacía: Shalom contesta "Aun no ha agregado envios a su lista"
  const sobre = (res: http.ServerResponse, data: unknown, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: status < 400, message: status < 400 ? "ok" : "error", data }));
  };
  const servidor = http.createServer((req, res) => {
    const cookie = req.headers.cookie ?? "";
    llamadas.push(`${req.method} ${req.url} ${req.headers["x-xsrf-token"] ?? "-"}`);
    let cuerpo = "";
    req.on("data", (c) => (cuerpo += c));
    req.on("end", () => {
      if (req.url === "/sanctum/csrf-cookie") {
        res.writeHead(204, { "Set-Cookie": ["XSRF-TOKEN=tok%3D1; path=/"] });
        return res.end();
      }
      if (!cookie.includes("enviashalom_session=valido")) return sobre(res, null, 401);
      if (req.url === "/api/v1/auth/me") return sobre(res, { email: "x@y" });
      if (req.url === "/api/v1/service-orders" && req.method === "GET") {
        // Como Shalom: la lista vacía viene como error.
        if (!borradores.length) return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: false, message: "Aun no ha agregado envios a su lista", data: null }));
        return sobre(res, borradores);
      }
      if (req.url === "/api/v1/service-orders/import") {
        assert.match(cuerpo, /envios\.xlsx/);
        borradores = [...borradores, { id: 2 }, { id: 3, error: "Agencia no válida" }, { id: 4 }];
        return sobre(res, { total: 3 });
      }
      if (req.url === "/api/v1/service-orders/security-code/massive") return sobre(res, JSON.parse(cuerpo));
      if (req.url === "/api/v1/service-orders/send") return sobre(res, JSON.parse(cuerpo));
      if (req.url?.startsWith("/api/v1/service-orders/shipments/tracking")) {
        const pagina = Number(new URL(req.url, "http://x").searchParams.get("page"));
        return sobre(res, {
          items: [{ serviceOrderIdEmpresarial: 105149320 + pagina, code: "3WND", receiver: { type: "person", document: "0264523" + pagina }, status: pagina === 1 ? "en_destino" : "en_transito", price: "12.00", destination: { name: "PIURA" } }],
          summary: { en_destino: 1 },
          meta: { current_page: pagina, last_page: 2 },
        });
      }
      if (req.url?.startsWith("/api/v1/service-orders/shipments/history")) {
        const pagina = Number(new URL(req.url, "http://x").searchParams.get("page"));
        return sobre(res, { current_page: pagina, last_page: 2, data: [{ order_number: `10${pagina}`, code: "AB", recipient_dni: "4841993" + pagina, status: "en_transito" }] });
      }
      sobre(res, null, 404);
    });
  });
  return { servidor, llamadas };
}

test("registro masivo: sube, pone la clave sólo a los nuevos sin error y los envía", async () => {
  const { servidor, llamadas } = shalomFalso();
  await new Promise<void>((r) => servidor.listen(0, r));
  const base = `http://127.0.0.1:${(servidor.address() as { port: number }).port}`;
  try {
    const cliente = new ClienteShalomPro("enviashalom_session=valido", base);
    await cliente.abrir();
    const r = await registrarMasivo(cliente, new Uint8Array([1, 2, 3]), "1126");
    assert.deepEqual(r.enviados.map((b) => b.id), [2, 4]);
    assert.deepEqual(r.conError.map((b) => b.id), [3]);
    const clave = llamadas.find((l) => l.includes("security-code"));
    assert.ok(clave?.endsWith("tok=1"), "manda el XSRF decodificado");
    const conEstado = (await rastreo(cliente)).map(leerEnvioShalom);
    assert.deepEqual(conEstado[0], { orden: "105149321", codigo: "3WND", dni: "02645231", estado: "en_destino", costo: 12, destino: "PIURA" });
    assert.equal(conEstado.length, 2);
    const envios = await historial(cliente, "2026-11-24", "2026-11-25");
    assert.deepEqual(envios.map((e) => e.order_number), ["101", "102"]);
  } finally {
    servidor.close();
  }
});

test("si la sesión venció, lo dice claro", async () => {
  const { servidor } = shalomFalso();
  await new Promise<void>((r) => servidor.listen(0, r));
  const base = `http://127.0.0.1:${(servidor.address() as { port: number }).port}`;
  try {
    const cliente = new ClienteShalomPro("enviashalom_session=vencido", base);
    await assert.rejects(cliente.abrir(), (e: Error) => e instanceof SesionVencida && /enviashalom_session/.test(e.message));
  } finally {
    servidor.close();
  }
});

test("lee los DNI que Shalom no tiene registrados", () => {
  const mensaje =
    "Se detectaron errores en las siguientes filas:<br><br>En la fila 6: documento: 16668407 del destinatario no está registrado.<br>En la fila 8: documento: 45083470 del destinatario no está registrado.<br>";
  assert.deepEqual(dnisNoRegistrados(mensaje), ["16668407", "45083470"]);
  assert.deepEqual(dnisNoRegistrados("En la fila 3: agencia no válida"), []);
});

test("si Shalom no tiene al destinatario, lo registra y vuelve a subir la tanda", async () => {
  let registrado = false;
  let personaCreada: Record<string, unknown> | null = null;
  const borradores: { id: number }[] = [];
  const servidor = http.createServer((req, res) => {
    let cuerpo = "";
    req.on("data", (c) => (cuerpo += c));
    req.on("end", () => {
      const json = (data: unknown, success = true, message = "ok") => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success, message, data }));
      };
      if (req.url === "/sanctum/csrf-cookie") return res.writeHead(204, { "Set-Cookie": ["XSRF-TOKEN=t; path=/"] }).end();
      if (req.url === "/api/v1/auth/me") return json({ email: "cuenta@solubre.pe" });
      if (req.url === "/api/v1/service-orders" && req.method === "GET") return borradores.length ? json(borradores) : json(null, false, "Aun no ha agregado envios a su lista");
      if (req.url === "/api/v1/service-orders/import") {
        if (!registrado) return json(null, false, "Se detectaron errores en las siguientes filas:<br><br>En la fila 2: documento: 16668407 del destinatario no está registrado.<br>");
        borradores.push({ id: 9 });
        return json({ total: 1 });
      }
      if (req.url === "/api/v1/person/search") return json({ name: "GUILLERMINA", surname: "AGUINAGA", lastname: "PAZ", document: "16668407" });
      if (req.url === "/api/v1/person") {
        personaCreada = JSON.parse(cuerpo);
        registrado = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ valor: true, msn: "Registrado", data: {} }));
      }
      if (req.url?.startsWith("/api/v1/service-orders/")) return json({ message: "Enviados" });
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => servidor.listen(0, r));
  const base = `http://127.0.0.1:${(servidor.address() as { port: number }).port}`;
  try {
    const cliente = new ClienteShalomPro("enviashalom_session=x", base);
    await cliente.abrir();
    const destinatarios = new Map([["16668407", { dni: "16668407", celular: "996971715", nombres: "GUILLERMINA", paterno: "AGUINAGA", materno: "PAZ" }]]);
    const r = await registrarMasivo(cliente, new Uint8Array([1]), "1127", destinatarios, "cuenta@solubre.pe");
    assert.deepEqual(r.enviados.map((b) => b.id), [9]);
    assert.equal(r.clientesNuevos?.length, 1);
    assert.equal(personaCreada?.["sur_name"], "AGUINAGA");
    assert.equal(personaCreada?.["last_name"], "PAZ");
    assert.equal(personaCreada?.["phone"], "996971715");
    assert.equal(personaCreada?.["email"], "cuenta@solubre.pe");
  } finally {
    servidor.close();
  }
});
