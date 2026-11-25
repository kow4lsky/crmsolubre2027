import assert from "node:assert/strict";
import test from "node:test";

import JSZip from "jszip";

import { diasQueAlcanza, emparejarConProductos, leerReporteSwayp } from "../src/lib/inventario.ts";
import { leerXlsx } from "../src/lib/leer-xlsx.ts";

async function excelDePrueba(filas: (string | number)[][]) {
  const zip = new JSZip();
  const fila = (r: (string | number)[], i: number) =>
    `<row r="${i + 1}">${r
      .map((v, j) =>
        typeof v === "number"
          ? `<c r="${String.fromCharCode(65 + j)}${i + 1}"><v>${v}</v></c>`
          : `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="inlineStr"><is><t>${v}</t></is></c>`,
      )
      .join("")}</row>`;
  zip.file("xl/worksheets/sheet1.xml", `<worksheet><sheetData>${filas.map(fila).join("")}</sheetData></worksheet>`);
  return zip.generateAsync({ type: "uint8array" });
}

test("lee el reporte de inventario de Swayp", async () => {
  const archivo = await excelDePrueba([
    ["Inventario"],
    ["CÓDIGO BARRAS", "NOMBRE", "BODEGA", "DISPONIBLE", "CANTIDAD", "RESERVADO", "EN TRÁNSITO", "EN DEVOLUCIÓN"],
    ["CV", "CEPILLO VERDE", "Bodega Lima", "1,637 unid.", 1637, 0, 34, 4],
    ["SOLUBRE", "SOLUBRE", "Bodega Lima", "93 unid.", 93, 0, 64, 8],
    ["BROCHAS", "BROCHAS", "Bodega Lima", "5 unid.", 5, 0, 0, 0],
  ]);
  const filas = leerReporteSwayp(await leerXlsx(archivo));
  assert.deepEqual(filas[0], { codigo: "CV", nombre: "CEPILLO VERDE", cantidad: 1637, transito: 34, devolucion: 4 });
  assert.equal(filas.length, 3);

  const productos = [
    { id: "1", nombre: "CEPILLO VERDE", codigo_swayp: null },
    { id: "2", nombre: "Solubre", codigo_swayp: null },
  ];
  const pares = emparejarConProductos(filas, productos);
  assert.equal(pares.get("CV")?.id, "1");
  assert.equal(pares.get("SOLUBRE")?.id, "2");
  assert.equal(pares.has("BROCHAS"), false);
  assert.throws(() => leerReporteSwayp([["hola"]]), /columnas/);
});

test("lee el Excel que exporta Swayp (títulos en inglés)", async () => {
  const archivo = await excelDePrueba([
    ["Product", "Barcode", "Company", "Warehouse", "Quantity", "InShipping", "InTransit", "InReturn", "Available"],
    ["CEPILLO VERDE", "CV", "SOLUBRE", "Bodega Lima", "1636", "2", "19", "3", "1636"],
    ["SOLUBRE", "SOLUBRE", "SOLUBRE", "Bodega Lima", "84", "0", "50", "7", "84"],
  ]);
  const filas = leerReporteSwayp(await leerXlsx(archivo));
  assert.deepEqual(filas, [
    { codigo: "CV", nombre: "CEPILLO VERDE", cantidad: 1636, transito: 21, devolucion: 3 },
    { codigo: "SOLUBRE", nombre: "SOLUBRE", cantidad: 84, transito: 50, devolucion: 7 },
  ]);
});

test("cuántos días alcanza", () => {
  assert.equal(diasQueAlcanza(93, 9.1), 10);
  assert.equal(diasQueAlcanza(93, 0), null);
});
