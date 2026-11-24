import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import JSZip from "jszip";

import { AGENCIAS_SHALOM } from "../src/lib/agencias-shalom.ts";
import { cajaShalom, llenarHojaShalom, problemasDeFilaShalom, productosPrincipales, sugerirAgencia } from "../src/lib/envios-masivos.ts";

test("la caja se decide por los productos principales, sin accesorios", () => {
  assert.equal(productosPrincipales("3xsolubre, 1xcv"), 3);
  assert.equal(productosPrincipales("2XSOLUBRE, 1XCV"), 2);
  assert.equal(productosPrincipales("4xlimpiaxpress, 4xchisgete, 1xcv"), 4);
  assert.equal(productosPrincipales("1xSOLUBRE, 1xMILDREW, 2xCEPILLO VERDE"), 2);
  assert.equal(productosPrincipales(""), 0);
  assert.equal(cajaShalom(2), "PAQUETE S");
  assert.equal(cajaShalom(3), "PAQUETE M");
  assert.equal(cajaShalom(0), "PAQUETE S");
});

test("reconoce la agencia de Shalom en la dirección", () => {
  assert.deepEqual(sugerirAgencia("Agencia Shalom Jaén", AGENCIAS_SHALOM).agencia, "JAEN CO");
  assert.equal(sugerirAgencia("Agencia Shalom Jaén", AGENCIAS_SHALOM).segura, true);
  // Las agencias con nombre de calle: "AV  BALTA CDRA. 36" se reconoce por BALTA.
  const balta = sugerirAgencia("Chiclayo agencia shalom av balta", AGENCIAS_SHALOM);
  assert.ok(balta.candidatas.some((a) => a.includes("BALTA")));
  assert.equal(sugerirAgencia("shalom aguas verdes tumbes", AGENCIAS_SHALOM).agencia, "AGUAS VERDES");
  const dudosa = sugerirAgencia("Agencia Shalom Chiclayo", AGENCIAS_SHALOM);
  assert.ok(dudosa.candidatas.length > 0);
  assert.equal(sugerirAgencia("Calle sin nombre 123", AGENCIAS_SHALOM).agencia, null);
});

test("avisa lo que falta para que Shalom acepte la fila", () => {
  assert.deepEqual(problemasDeFilaShalom({ documento: "70503353", telefono: "987654321", destino: "JAEN CO", caja: "PAQUETE S" }, AGENCIAS_SHALOM), []);
  assert.deepEqual(problemasDeFilaShalom({ documento: "7050", telefono: "12345", destino: "LUNA", caja: "PAQUETE S" }, AGENCIAS_SHALOM), [
    "DNI de 8 dígitos (o RUC de 11)",
    "celular de 9 dígitos",
    "agencia de destino",
  ]);
});

test("llena la plantilla real de Shalom desde la fila 2", async () => {
  const zip = await JSZip.loadAsync(await readFile("public/plantillas/shalom-masivo.xlsx"));
  const hoja = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  const llena = llenarHojaShalom(hoja, [
    { documento: "48419937", telefono: "948584475", destino: "JAEN CO", caja: "PAQUETE M" },
    { documento: "12345678", telefono: "912345678", destino: "AGUAS VERDES", caja: "PAQUETE S" },
  ]);
  const fila = (r: number) => new RegExp(`<row r="${r}"[^>]*>[\\s\\S]*?</row>`).exec(llena)![0];
  const f2 = fila(2);
  assert.match(f2, /<c r="A2" s="4"><v>48419937<\/v><\/c>/);
  assert.match(f2, /<c r="B2" s="4"><v>948584475<\/v><\/c>/);
  assert.match(f2, /<c r="F2" s="1" t="inlineStr"><is><t>AV JOSE LEAL CDRA 6<\/t><\/is><\/c>/);
  assert.match(f2, /<t>JAEN CO<\/t>/);
  assert.match(f2, /<t>PAQUETE M<\/t>/);
  assert.match(f2, /<c r="L2" s="3"><v>5<\/v><\/c>/);
  assert.doesNotMatch(f2, /70503353/); // el ejemplo de Shalom ya no está
  const f3 = fila(3);
  assert.match(f3, /<t>AGUAS VERDES<\/t>/);
  assert.match(f3, /<c r="L3" s="3"><v>2<\/v><\/c>/);
  assert.match(fila(4), /<c r="A4" s="4"\/>/); // lo demás queda vacío
  // Sigue siendo un XML que abre: mismas filas que antes.
  assert.equal((llena.match(/<row /g) ?? []).length, (hoja.match(/<row /g) ?? []).length);
});
