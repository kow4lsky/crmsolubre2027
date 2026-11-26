import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import JSZip from "jszip";

import { AGENCIAS_SHALOM } from "../src/lib/agencias-shalom.ts";
import { cajaShalom, documentosRechazadosShalom, nombreEnTresPartes, llenarHojaShalom, textoDeShalom, problemasDeFilaShalom, productosPrincipales, sugerirAgencia } from "../src/lib/envios-masivos.ts";

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

/* ------------------------------------------------------------------ Olva */

import { llenarHojaOlva, partirNombre, problemasDeFilaOlva, sugerirTiendaOlva } from "../src/lib/envios-masivos.ts";
import { TIENDAS_OLVA } from "../src/lib/tiendas-olva.ts";

test("parte el nombre en nombres y apellido paterno", () => {
  assert.deepEqual(partirNombre("Benjamin Israel Juárez Rodriguez"), { nombres: "Benjamin Israel", apellido: "Juárez" });
  assert.deepEqual(partirNombre("Jhony Peña"), { nombres: "Jhony", apellido: "Peña" });
  assert.deepEqual(partirNombre("Rosa Mendoza Ruiz"), { nombres: "Rosa", apellido: "Mendoza" });
  assert.deepEqual(partirNombre("HERNAN"), { nombres: "HERNAN", apellido: "HERNAN" });
});

test("reconoce la tienda Olva por distrito y calle", () => {
  const abancay = sugerirTiendaOlva("Olva Abancay av Elias", TIENDAS_OLVA);
  assert.equal(abancay.tienda?.distrito, "ABANCAY");
  assert.equal(abancay.segura, true);
  const parra = sugerirTiendaOlva("tienda olva av parra arequipa", TIENDAS_OLVA);
  assert.match(parra.tienda?.tienda ?? "", /PARRA/);
  assert.equal(sugerirTiendaOlva("Calle sin nombre", TIENDAS_OLVA).tienda, null);
});

test("avisa lo que falta para Olva", () => {
  const tienda = TIENDAS_OLVA[0];
  assert.deepEqual(problemasDeFilaOlva({ documento: "08419937", nombres: "Ana", apellido: "Pérez", telefono: "948584475", tienda }), []);
  assert.deepEqual(problemasDeFilaOlva({ documento: "123", nombres: "", apellido: "", telefono: "1", tienda: null }), [
    "DNI de 8 dígitos",
    "nombres y apellido",
    "celular de 9 dígitos",
    "tienda Olva de destino",
  ]);
});

test("llena la plantilla real de Olva desde la fila 5, con el DNI como texto", async () => {
  const zip = await JSZip.loadAsync(await readFile("public/plantillas/olva-masivo.xlsm"));
  const hoja = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  const tienda = TIENDAS_OLVA.find((t) => t.distrito === "ABANCAY")!;
  const llena = llenarHojaOlva(hoja, [{ documento: "08419937", nombres: "Ana María", apellido: "Pérez", telefono: "948584475", tienda }]);
  const f5 = /<row r="5"[^>]*>[\s\S]*?<\/row>/.exec(llena)![0];
  assert.match(f5, /<c r="A5" s="4" t="n"><v>1<\/v><\/c>/); // el N° de la plantilla queda
  assert.match(f5, /<c r="C5" s="5" t="inlineStr"><is><t>08419937<\/t><\/is><\/c>/);
  assert.match(f5, /<t>Ana María<\/t>/);
  assert.match(f5, /<c r="J5" s="4" t="inlineStr"><is><t>Entrega en tienda<\/t>/);
  assert.match(f5, /<t>APURIMAC<\/t>/);
  assert.match(f5, /<t>TIENDA ABANCAY - AV ELIAS/);
  assert.match(f5, /<t>Paquete S<\/t>/);
  assert.match(f5, /<c r="R5" s="4"><v>30<\/v><\/c>/);
  assert.match(f5, /<t>ARTÍCULOS DE LIMPIEZA<\/t>/);
  assert.match(f5, /<c r="W5" s="4"><v>50<\/v><\/c>/);
  assert.match(f5, /<c r="Y5" s="4" t="inlineStr"><is><t>NO<\/t><\/is><\/c>/); // cargo adjunto: lo de la plantilla
  assert.match(f5, /<c r="AA5"><f>/); // las fórmulas de Olva siguen
  assert.match(/<row r="6"[^>]*>[\s\S]*?<\/row>/.exec(llena)![0], /<c r="B6" s="\d+" t="n" \/>/);
});

test("lee los DNI que Shalom rechazó", () => {
  const mensaje =
    "Shalom PRO: Se detectaron errores en las siguientes filas:<br><br>En la fila 6: documento: 16668407 del destinatario no está registrado.<br>En la fila 8: documento: 45083470 del destinatario no está registrado.<br>";
  assert.deepEqual(documentosRechazadosShalom(mensaje), ["16668407", "45083470"]);
  assert.equal(textoDeShalom(mensaje).split("\n").length, 3);
  assert.doesNotMatch(textoDeShalom(mensaje), /<br>/);
});

test("separa nombres y apellidos paterno y materno", () => {
  assert.deepEqual(nombreEnTresPartes("Guillermina Aguinaga Paz"), { nombres: "Guillermina", paterno: "Aguinaga", materno: "Paz" });
  assert.deepEqual(nombreEnTresPartes("David Misael Pariona Untiveros"), { nombres: "David Misael", paterno: "Pariona", materno: "Untiveros" });
  assert.deepEqual(nombreEnTresPartes("Juan Tello"), { nombres: "Juan", paterno: "Tello", materno: "" });
});
