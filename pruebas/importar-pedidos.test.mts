/**
 * Pruebas de la importación de la pestaña "base" del Google Sheet.
 *
 * La planilla la cargaron muchas personas durante años: fechas con y sin hora,
 * montos con "S/", estados escritos a mano. Lo que se cuida es que cada dato
 * caiga en su columna y que lo que no se entiende quede guardado, no perdido.
 */
import assert from "node:assert";
import { test } from "node:test";

import { leerCsv } from "../src/lib/importar.ts";
import { leerCelular, leerDia, leerEstado, leerMomento, leerMonto, leerPedidos } from "../src/lib/importar-pedidos.ts";

test("lee montos como los escribe la planilla", () => {
  assert.equal(leerMonto("S/ 89.90"), 89.9);
  assert.equal(leerMonto("1,234.50"), 1234.5);
  assert.equal(leerMonto("89,90"), 89.9);
  assert.equal(leerMonto("1,234"), 1234);
  assert.equal(leerMonto(""), null);
  assert.equal(leerMonto("—"), null);
});

test("lee fechas con y sin hora, en hora de Lima", () => {
  assert.equal(leerDia("24/11/2026"), "2026-11-24");
  assert.equal(leerDia("4/1/2026"), "2026-01-04");
  assert.equal(leerDia("2026-11-24"), "2026-11-24");
  assert.equal(leerDia("31/02/2026"), null);
  assert.equal(leerMomento("24/11/2026 15:30"), "2026-11-24T15:30:00-05:00");
  assert.equal(leerMomento("24/11/2026"), "2026-11-24T00:00:00-05:00");
});

test("reconoce los estados escritos de distintas formas", () => {
  assert.equal(leerEstado("en transito"), "EN TRÁNSITO");
  assert.equal(leerEstado("Coordinacion"), "COORDINACIÓN");
  assert.equal(leerEstado("RELLAMAR"), "VOLVER A LLAMAR");
  assert.equal(leerEstado(""), "VOLVER A LLAMAR");
  assert.equal(leerEstado("PERDIDO"), null);
});

test("el celular queda con 9 dígitos", () => {
  assert.equal(leerCelular("+51 987 654 321"), "987654321");
  assert.equal(leerCelular("987654321"), "987654321");
});

const CSV = [
  "COD,F.CRE,F.REG,MONTO,PEDIDO,CLIENTE,DIRECCION,DNI,PROVINCIA ,DISTRITO,CELULAR, DESTINO,ESTADO,ASESOR,CANAL,SOLUBRE,CEPILLO VERDE,CREADO POR,PAQUETE SHALOM",
  'WED7649,24/11/2026 10:05,24/11/2026,S/ 89.90,"3xsolubre, 1xcv",Benjamin,Av. Lima,48419937,trujillo,,948584475,Provincia,CONFIRMADO,MILTON,WEB,3,1,MBV0726,P-123',
  "WED7648,23/11/2026,23/11/2026,49.5,2xsolubre,Jhony,,,LIMA,,941945043,Lima,en transito,DIEGO,,2,,,",
  "WED7600,01/04/2026,01/04/2026,10,x,Viejo,,,,,,,PERDIDO,,,,,,",
  ",,,,,,,,,,,,,,,,,,",
  "WED7648,23/11/2026,23/11/2026,55,2xsolubre,Jhony,,,LIMA,,941945043,Lima,ENTREGADO,DIEGO,,2,,,",
].join("\n");

test("convierte la planilla en pedidos con productos y otros datos", () => {
  const lectura = leerPedidos(leerCsv(CSV));
  assert.equal(lectura.error, null);
  // WED7648 está dos veces: no entra ninguna de sus filas.
  assert.equal(lectura.filas.length, 2);
  assert.equal(lectura.codigosRepetidos, 1);

  const primero = lectura.filas.find((f) => f.codigo === "WED7649")!;
  assert.equal(primero.fecha_registro, "2026-11-24");
  assert.equal(primero.fecha_creacion, "2026-11-24T10:05:00-05:00");
  assert.equal(primero.monto, 89.9);
  assert.equal(primero.pedido, "3xsolubre, 1xcv");
  assert.equal(primero.provincia, "trujillo");
  assert.equal(primero.destino, "Provincia");
  assert.deepEqual(primero.items, { SOLUBRE: 3, "CEPILLO VERDE": 1 });
  // El código viejo de usuario se unifica con el nombre del asesor.
  assert.equal(primero.creado_por, "MILTON");
  assert.deepEqual(primero.extra, { "PAQUETE SHALOM": "P-123" });

  assert.equal(lectura.filas.some((f) => f.codigo === "WED7648"), false);
  assert.deepEqual(lectura.detalleRepetidos.map((d) => [d.codigo, d.estado]), [
    ["WED7648", "EN TRÁNSITO"],
    ["WED7648", "ENTREGADO"],
  ]);
});

test("un estado desconocido no se pierde", () => {
  const lectura = leerPedidos(leerCsv(CSV));
  const viejo = lectura.filas.find((f) => f.codigo === "WED7600")!;
  assert.equal(viejo.estado, "VOLVER A LLAMAR");
  assert.equal(viejo.extra["ESTADO ORIGINAL"], "PERDIDO");
  assert.deepEqual(lectura.estadosDesconocidos, { PERDIDO: 1 });
});

test("puede importar sólo desde una fecha", () => {
  const lectura = leerPedidos(leerCsv(CSV), "2026-06-01");
  assert.equal(lectura.filas.length, 1);
  assert.equal(lectura.fueraDeRango, 1);
});

test("avisa si el archivo no es la pestaña base", () => {
  assert.match(leerPedidos(leerCsv("Nombre,Teléfono\nAna,123")).error ?? "", /COD/);
});

test("un código repetido no entra, aunque una de sus filas sea vieja", () => {
  const csv = [
    "COD,F.REG,CLIENTE,CELULAR,ESTADO",
    "WED10,01/01/2026,Ana,911111111,ENTREGADO",
    "WED10,02/11/2026,Beto,922222222,CONFIRMADO",
    "WED11,03/11/2026,Caro,933333333,NC",
  ].join("\n");
  const lectura = leerPedidos(leerCsv(csv), "2026-06-01");
  assert.deepEqual(lectura.filas.map((f) => f.codigo), ["WED11"]);
  assert.equal(lectura.codigosRepetidos, 1);
  assert.equal(lectura.detalleRepetidos.length, 2);
  assert.equal(lectura.detalleRepetidos[0].decision, "No se importa: código repetido");
});
