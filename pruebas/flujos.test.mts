/**
 * Pruebas de los pedidos que llegan de Flujos Inteligentes: que sólo pasen
 * las ventas de la IA y que cada dato caiga en su campo del CRM.
 */
import assert from "node:assert";
import { test } from "node:test";

import { esDeIA, propuestaDesdeFlujos } from "../src/lib/flujos.ts";

const CATALOGO = ["SOLUBRE", "LIMPIAXPRESS", "CHISGUETE"];

const pedido = {
  id: "2998d0cd-9d82-485e-a9ce-d8e08d09227b",
  created_at: "2026-11-23T21:12:54.636508+00:00",
  department: "Ayacucho",
  provincia: "Huamanga",
  distrito: "Carmen Alto",
  lead_name: "Juana Huamán",
  phone: "+51 987 654 321",
  document: "48419937",
  total_amount: 115,
  shipping_type: "agencia",
  shipping_agency: "Agencia Carmen Alto",
  courier: "Shalom",
  payment_type: "adelanto",
  amount_paid: 30,
  created_by_ai: true,
  productos: [
    { name: "Limpiaxpress sacagrasa", quantity: 3 },
    { name: "Chisguete", quantity: 1 },
  ],
};

test("sólo pasan las ventas de la IA", () => {
  assert.equal(esDeIA(pedido), true);
  assert.equal(esDeIA({ ...pedido, created_by_ai: false }), false);
  assert.equal(esDeIA({}), false);
});

test("un pedido de Flujos se traduce a los campos del CRM", () => {
  const p = propuestaDesdeFlujos(pedido, CATALOGO);
  assert.equal(p.cliente, "Juana Huamán");
  assert.equal(p.celular, "987654321");
  assert.equal(p.dni, "48419937");
  assert.equal(p.destino, "Provincia");
  assert.equal(p.provincia, "Huamanga");
  assert.equal(p.distrito, "Carmen Alto");
  assert.equal(p.direccion, "Agencia Carmen Alto");
  assert.equal(p.monto, 115);
  assert.equal(p.adelanto, 30);
  assert.equal(p.courier, "Shalom");
  assert.equal(p.envio, "Prov.Agencia");
  assert.equal(p.inventario, "SOLUBRE");
  assert.equal(p.cerrado_por, "IA");
  assert.equal(p.canal, "WASAP IA");
  assert.equal(p.fecha_registro, "2026-11-23");
  assert.deepEqual(p.items, [
    { producto: "LIMPIAXPRESS", cantidad: 3 },
    { producto: "CHISGUETE", cantidad: 1 },
  ]);
  assert.equal(p.pedido, "3xLIMPIAXPRESS, 1xCHISGUETE");
  assert.match(p.nota, /Agencia Carmen Alto/);
});

test("Lima se reconoce y lo que falta queda vacío", () => {
  const p = propuestaDesdeFlujos({ department: "Lima", provincia: "Lima", created_by_ai: true }, CATALOGO);
  assert.equal(p.destino, "Lima");
  assert.equal(p.celular, null);
  assert.equal(p.cliente, "Cliente de WhatsApp");
  assert.equal(p.envio, null);
});

test("habla MCP: sesión, respuesta en eventos y texto JSON", async () => {
  const http = await import("node:http");
  const { llamarHerramientaMcp } = await import("../src/lib/mcp-cliente.ts");
  const vistos: string[] = [];
  const servidor = http.createServer((req, res) => {
    let cuerpo = "";
    req.on("data", (c) => (cuerpo += c));
    req.on("end", () => {
      const msg = JSON.parse(cuerpo);
      vistos.push(`${msg.method}|${req.headers["mcp-session-id"] ?? "-"}|${req.headers.authorization}`);
      if (msg.method === "initialize") {
        res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "s-1" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26" } }));
      }
      if (!("id" in msg)) {
        res.writeHead(202);
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const texto = JSON.stringify({ items: [{ id: "a", created_by_ai: true }], has_more: false, args: msg.params.arguments });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: texto }] } })}\n\n`);
    });
  });
  await new Promise<void>((r) => servidor.listen(0, r));
  const puerto = (servidor.address() as { port: number }).port;
  try {
    const r = await llamarHerramientaMcp(`http://127.0.0.1:${puerto}/mcp`, "tok", "orders_list", { limit: 50 });
    assert.deepEqual(r.items, [{ id: "a", created_by_ai: true }]);
    assert.deepEqual(r.args, { limit: 50 });
    assert.deepEqual(vistos, [
      "initialize|-|Bearer tok",
      "notifications/initialized|s-1|Bearer tok",
      "tools/call|s-1|Bearer tok",
    ]);
  } finally {
    servidor.close();
  }
});

test("si Cloudflare frena al CRM, lo dice claro y sin HTML", async () => {
  const http = await import("node:http");
  const { llamarHerramientaMcp } = await import("../src/lib/mcp-cliente.ts");
  let agente = "";
  const servidor = http.createServer((req, res) => {
    agente = String(req.headers["user-agent"]);
    res.writeHead(403, { "Content-Type": "text/html", "cf-mitigated": "challenge" });
    res.end('<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head></html>');
  });
  await new Promise<void>((r) => servidor.listen(0, r));
  const puerto = (servidor.address() as { port: number }).port;
  try {
    await assert.rejects(
      llamarHerramientaMcp(`http://127.0.0.1:${puerto}/mcp`, "tok", "orders_list", {}),
      (e: Error) => e.message.includes("anti-robots") && !e.message.includes("<"),
    );
    assert.match(agente, /crm-solubre/);
  } finally {
    servidor.close();
  }
});
