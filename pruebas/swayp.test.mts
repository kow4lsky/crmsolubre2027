/**
 * Pruebas de los avisos de Swayp: que sólo entre lo que firmó Swayp y que el
 * estado del pedido se mueva como corresponde, sin reabrir uno cerrado.
 */
import assert from "node:assert";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { estadoDelCrm, leerAvisoSwayp, verificarFirmaSwayp } from "../src/lib/swayp.ts";

test("sólo acepta lo que firmó Swayp", () => {
  const cuerpo = '{"order_number":"10000022753","status":"Entregada","status_code":"7"}';
  const firma = `sha256=${createHmac("sha256", "secreto").update(cuerpo).digest("hex")}`;
  assert.equal(verificarFirmaSwayp(cuerpo, firma, "secreto"), true);
  assert.equal(verificarFirmaSwayp(cuerpo, firma, "otro"), false);
  assert.equal(verificarFirmaSwayp(cuerpo.replace("7", "5"), firma, "secreto"), false);
  assert.equal(verificarFirmaSwayp(cuerpo, null, "secreto"), false);
});

test("lee el aviso", () => {
  assert.deepEqual(leerAvisoSwayp({ order_number: 10000022753, status: "Entregada", status_code: "7", comment: "ok" }), {
    guia: "10000022753",
    codigo: "7",
    estado: "Entregada",
    comentario: "ok",
  });
  assert.equal(leerAvisoSwayp({ status_code: "7" }), null);
});

test("el estado del pedido sigue a la guía sin reabrir cerrados", () => {
  assert.equal(estadoDelCrm("5", "CONFIRMADO"), "EN TRÁNSITO");
  assert.equal(estadoDelCrm("5", "EN TRÁNSITO"), null);
  assert.equal(estadoDelCrm("4", "ENTREGADO"), null);
  assert.equal(estadoDelCrm("7", "EN TRÁNSITO"), "ENTREGADO");
  assert.equal(estadoDelCrm("7", "RECHAZADO"), "ENTREGADO");
  assert.equal(estadoDelCrm("7", "ENTREGADO"), null);
  assert.equal(estadoDelCrm("8", "EN TRÁNSITO"), "EN DEVOLUCIÓN");
  assert.equal(estadoDelCrm("12", "ENTREGADO"), null);
  assert.equal(estadoDelCrm("6", "EN TRÁNSITO"), null);
});

test("lee una guía de la lista por fechas de Swayp", async () => {
  const { leerGuiaSwayp } = await import("../src/lib/swayp.ts");
  const g = leerGuiaSwayp({ guia: 10000022753, idEstado: 7, estado: "Entregada", id: "wed236100", telefonoDestinatario: "+51 997 556 514", valorFlete: "8.00", valorRecaudo: "89.90" });
  assert.deepEqual(g, { guia: "10000022753", codigo: "7", estado: "Entregada", idExterno: "WED236100", celular: "997556514", costo: 8, recaudo: 89.9 });
  assert.equal(leerGuiaSwayp({ numeroGuia: "1", estado: "Reparto" }).codigo, "5");
});
