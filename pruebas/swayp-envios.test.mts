import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { sugerirDistrito } from "../src/lib/distritos-lima.ts";
import { crearXlsx } from "../src/lib/escribir-xlsx.ts";
import { leerXlsx } from "../src/lib/leer-xlsx.ts";
import {
  COLUMNAS_EXCEL_SWAYP,
  cuerpoGuiaSwayp,
  filaSwaypDesdePedido,
  filasExcelSwayp,
  medidasDe,
  problemasDeFilaSwayp,
  productosParaSwayp,
} from "../src/lib/swayp-envios.ts";

test("encuentra el distrito de Lima como se escriba", () => {
  assert.equal(sugerirDistrito("santiago de surco").distrito?.ubigeo, "150140");
  assert.equal(sugerirDistrito("Surco").distrito?.nombre, "Santiago de Surco");
  assert.equal(sugerirDistrito("SJL").distrito?.ubigeo, "150132");
  assert.equal(sugerirDistrito("La Victoria").distrito?.ubigeo, "150115");
  assert.equal(sugerirDistrito("Magdalena").distrito?.ubigeo, "150120");
  assert.equal(sugerirDistrito(null, "", "Av. Arequipa 123, Miraflores").seguro, false);
  assert.equal(sugerirDistrito(null, "", "Av. Arequipa 123, Miraflores").distrito?.ubigeo, "150122");
  assert.equal(sugerirDistrito("Huanta").distrito, null);
});

const pedido = {
  id: "p1",
  codigo: "WED236100",
  cliente: "Carmen Almeyda ",
  celular: "997556514",
  dni: "12345678",
  direccion: "Calle 7 nro 211 dpto 301",
  distrito: null,
  provincia: "San Borja",
  monto: 89.9,
  adelanto: 0,
  pedido: "3xSOLUBRE, 1xCEPILLO VERDE",
  nota: "PAGA CON TARJETA",
  envio: "Express",
};

test("arma el Excel de carga masiva como el que se subía a mano", async () => {
  const fila = filaSwaypDesdePedido(pedido, "2026-11-25");
  assert.deepEqual(problemasDeFilaSwayp(fila), []);
  const filas = filasExcelSwayp([fila]);
  assert.deepEqual(filas[1], [
    "WED236100", "Carmen Almeyda", "997556514", "SOLUBRE", "", "LIMA", "San Borja", "Calle 7 nro 211 dpto 301", "", "89.90", "", "",
    "3xSOLUBRE, 1xCEPILLO VERDE", "", "", "", "", "2026-11-25", "PAGA CON TARJETA", "1", "EXPRESS",
  ]);
  // Ida y vuelta por un .xlsx de verdad.
  const leidas = await leerXlsx(await crearXlsx(filas));
  assert.deepEqual(leidas[0], COLUMNAS_EXCEL_SWAYP);
  assert.equal(leidas[1][6], "San Borja");

  // Los mismos títulos que el Excel real de Swayp.
  try {
    const real = await leerXlsx(readFileSync(process.env.EXCEL_SWAYP ?? "/nada"));
    assert.deepEqual(real[0], COLUMNAS_EXCEL_SWAYP);
  } catch (e) {
    if (!(e instanceof Error && /ENOENT/.test(e.message))) throw e;
  }
});

test("el cuerpo de la guía para la API de Swayp", () => {
  const fila = { ...filaSwaypDesdePedido({ ...pedido, adelanto: 20, envio: "Prog.Normal" }, "2026-11-25") };
  const cuerpo = cuerpoGuiaSwayp(
    fila,
    { nombre: "SOLUBRE", nit: "20123456789", direccion: "Av. X 123", telefono: "999999999", email: "ventas@x.pe", ubigeo: "150116", idBodega: 132 },
    medidasDe("25x20x10", "1.5"),
    productosParaSwayp([{ producto: "Solubre", cantidad: 3 }], new Map([["SOLUBRE", "SOLUBRE"]])) ?? undefined,
  );
  assert.equal(cuerpo.ciudadDestinatario, "150130");
  assert.equal(cuerpo.valorRecaudo, "69.90");
  assert.equal(cuerpo.isExpress, false);
  assert.equal(cuerpo.idWarehouse, 132);
  assert.equal(cuerpo.largo, "25");
  assert.equal(cuerpo.peso, "1.5");
  assert.match(String(cuerpo.observaciones), /^Pedido WED236100/);
  assert.deepEqual(cuerpo.productos, [{ cantidad: 3, codbar: "SOLUBRE", nombre: "SOLUBRE" }]);
  assert.equal(productosParaSwayp([{ producto: "BROCHAS", cantidad: 1 }], new Map()), null);
  // Sin datos de remitente, como en el Excel: no se mandan vacíos.
  const minimo = cuerpoGuiaSwayp(fila, { nombre: "SOLUBRE", nit: "", direccion: "", telefono: "", email: "cuenta@x.pe", ubigeo: "" }, medidasDe("", ""));
  assert.equal("nitRemitente" in minimo, false);
  assert.equal("ciudadRemitente" in minimo, false);
  assert.equal(minimo.nombreRemitente, "SOLUBRE");
  assert.equal(minimo.emailDestinatario, "cuenta@x.pe");
  assert.deepEqual(problemasDeFilaSwayp({ ...fila, distrito: "", telefono: "123" }), ["celular de 9 dígitos", "distrito"]);
});
