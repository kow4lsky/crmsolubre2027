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
