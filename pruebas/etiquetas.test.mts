import assert from "node:assert/strict";
import test from "node:test";

import { htmlDeEtiquetas } from "../src/lib/etiquetas.ts";

test("arma la hoja de etiquetas A4, 10 por hoja", () => {
  const una = { tracking: "102366860 - KPD7", cliente: "Héctor Altamirano", dni: "16653148", direccion: "Huaraz Independencia", pedido: "3xLIMPIAXPRESS,1xCV" };
  const html = htmlDeEtiquetas(Array.from({ length: 12 }, () => una));
  assert.equal((html.match(/class="hoja"/g) ?? []).length, 2);
  assert.equal((html.match(/class="etiqueta"/g) ?? []).length, 20);
  assert.match(html, /102366860 - KPD7/);
  assert.match(html, /HUARAZ INDEPENDENCIA/);
  assert.match(html, /3XLIMPIAXPRESS, 1XCV/);
  assert.match(html, /SOLUBRE/);
  assert.doesNotMatch(htmlDeEtiquetas([{ ...una, cliente: "<b>x</b>" }]), /<b>x<\/b>/);
  assert.match(htmlDeEtiquetas([una], "/etiqueta-logo.png"), /<img class="logo" src="\/etiqueta-logo.png"/);
});
