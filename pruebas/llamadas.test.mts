import assert from "node:assert/strict";
import test from "node:test";

import { estaCerrado, etiquetaDeEtapa, leadDeLlamada, pedidosQueDuplican } from "../src/lib/llamadas.ts";

test("un lead de Flujos → la fila de llamadas", () => {
  const lead = {
    id: "3fb4",
    stage: "mensajes-entrantes",
    created_at: "2026-11-26T20:29:03Z",
    tags: ["d7d9"],
    name: "Carla Mendoza",
    phone: "+51 987 654 321",
    anuncio: { headline: "Solubre Limpieza", body: "#limpiaxpress te ayuda a retirar la suciedad" },
  };
  const fila = leadDeLlamada(lead, new Map([["d7d9", "NC – 1er Call"]]), ["SOLUBRE", "LIMPIAXPRESS", "CEPILLO VERDE"]);
  assert.equal(fila?.celular, "987654321");
  assert.equal(fila?.producto, "LIMPIAXPRESS");
  assert.equal(leadDeLlamada({ ...lead, anuncio: { headline: "Solubre Limpieza", body: "Envío gratis" } }, new Map(), ["SOLUBRE"])?.producto, "SOLUBRE");
  assert.deepEqual(fila?.etiquetas, ["NC – 1er Call"]);
  assert.equal(fila?.nombre, "Carla Mendoza");
  const sinMarca = leadDeLlamada({ ...lead, anuncio: { headline: "Oferta", body: "#limpiaxpress quita la grasa" } }, new Map(), ["SOLUBRE", "LIMPIAXPRESS"]);
  assert.equal(sinMarca?.producto, "LIMPIAXPRESS");
  assert.equal(leadDeLlamada({ name: "x" }, new Map(), []), null);
  assert.equal(estaCerrado("ventas-concretadas"), true);
  assert.equal(estaCerrado("en-seguimiento"), false);
  assert.equal(etiquetaDeEtapa("mensajes-entrantes"), "Mensajes entrantes");
});

test("no se duplica un pedido del mismo día; uno de otra fecha sí se puede", () => {
  const pedidos = [{ codigo: "A", fecha_registro: "2026-11-26" }, { codigo: "B", fecha_registro: "2026-10-02" }];
  assert.deepEqual(pedidosQueDuplican(pedidos, "2026-11-26").map((p) => p.codigo), ["A"]);
  assert.deepEqual(pedidosQueDuplican(pedidos, "2026-11-27"), []);
});
