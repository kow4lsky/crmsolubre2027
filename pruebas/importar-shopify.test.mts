import assert from "node:assert/strict";
import test from "node:test";

import { leerCsv } from "../src/lib/importar.ts";
import { diaDeLima, leerBaseShopify, numerosYaAtendidos, pedidoDesdeBaseShopify } from "../src/lib/importar-shopify.ts";

const vacias = (n: number) => Array.from({ length: n }, () => "");
function fila(numero: string, fecha: string, envio: string, nombre: string, celular: string, cantidad = "3") {
  const c = vacias(31);
  c[0] = numero;
  c[1] = `${fecha.replace(" ", "T")}:00.000Z`;
  c[2] = fecha;
  c[3] = "64.9";
  c[4] = "Solubre Limpieza para Pisos";
  c[5] = cantidad;
  c[6] = "0";
  c[7] = envio;
  c[8] = nombre;
  c[9] = "Pérez";
  c[25] = `${nombre} Pérez`;
  c[26] = "Av. Siempre Viva 123";
  c[27] = "12345678";
  c[28] = "Lima";
  c[29] = "Surco";
  c[30] = celular;
  return c;
}

test("lee BASE_SHOPIFY sin títulos, con borradores #D y repetidos", () => {
  const filas = [
    fila("23704", "2026-09-30 03:15", "Envío Provincia", "Pepito", "+51 987 654 321"),
    fila("#D2505", "2026-10-02 10:10", "Envío Lima - Callao", "Gomez", "912345678", "1"),
    fila("23704", "2026-09-30 03:15", "Envío Provincia", "Pepito", "987654321"),
    vacias(31),
  ];
  const l = leerBaseShopify(filas);
  assert.equal(l.error, null);
  assert.equal(l.repetidos, 1);
  assert.deepEqual(l.pedidos.map((p) => p.origen), ["23704", "D2505"]);
  const [a, b] = l.pedidos;
  assert.equal(a.celular, "987654321");
  assert.equal(a.destino, "Provincia");
  assert.equal(a.fecha, "2026-09-30T03:15:00-05:00");
  assert.equal(a.cliente, "Pepito Pérez");
  assert.equal(b.destino, "Lima");
  assert.equal(b.cantidad, 1);
});

test("el filtro de fecha deja afuera los anteriores", () => {
  const l = leerBaseShopify([fila("1001", "2026-09-30 23:00", "", "A", "900000001"), fila("1002", "2026-11-20 08:00", "", "B", "900000002")], "2026-11-01");
  assert.equal(l.fueraDeRango, 1);
  assert.deepEqual(l.pedidos.map((p) => p.origen), ["1002"]);
  assert.equal(diaDeLima("2026-09-30T23:00:00-05:00"), "2026-09-30");
});

test("si no es la pestaña, lo dice", () => {
  assert.match(leerBaseShopify(leerCsv("COD,CLIENTE\nWED1,Ana\n")).error ?? "", /BASE_SHOPIFY/);
});

test("los ya atendidos se reconocen por la nota o por el webhook", () => {
  const atendidos = numerosYaAtendidos([
    { nota: "Llamar tarde\nOrigen Shopify: 23704", extra: {} },
    { nota: "Origen Shopify: #D2505", extra: null },
    { nota: "Shopify #23800", extra: { "SHOPIFY PEDIDO": "#23800" } },
    { nota: null, extra: null },
  ]);
  assert.deepEqual([...atendidos.keys()].sort(), ["23704", "23800", "D2505"]);
});

test("arma el pedido: VOLVER A LLAMAR, asesora, canal, marca de origen y producto del catálogo", () => {
  const [p] = leerBaseShopify([fila("23704", "2026-09-30 03:15", "Envío Provincia", "Pepito", "987654321")]).pedidos;
  const ahora = new Date("2026-11-24T15:00:00Z");
  const { fila: f, items } = pedidoDesdeBaseShopify(p, { asesor: "YAHAIRA", catalogo: ["SOLUBRE", "BROCHAS"], ahora });
  assert.equal(f.estado, "VOLVER A LLAMAR");
  assert.equal(f.asesor, "YAHAIRA");
  assert.equal(f.canal, "SHOPIFY");
  assert.equal(f.fecha_registro, "2026-09-30");
  assert.equal(f.pedido, "3xSOLUBRE");
  assert.equal(f.monto, 64.9);
  assert.equal(f.prox_llamada_at, ahora.toISOString());
  assert.match(f.nota, /^Origen Shopify: 23704\nEnvío Shopify: Envío Provincia$/);
  assert.deepEqual(items, [{ producto: "SOLUBRE", cantidad: 3 }]);
  // Al volver a analizar, el que se acaba de crear ya figura como atendido.
  assert.ok(numerosYaAtendidos([{ nota: f.nota, extra: f.extra }]).has("23704"));
});
