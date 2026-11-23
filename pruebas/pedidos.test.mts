/**
 * Pruebas de la lógica de pedidos: quién puede cambiar qué estado y los
 * formatos que se copian a las planillas de despacho, etiquetas y SMS.
 *
 * Las columnas de despacho tienen que salir en el orden exacto que usaba el
 * CRM de Apps Script: se pegan en hojas que ya existen y una columna corrida
 * manda un paquete a la dirección de otro.
 */
import assert from "node:assert";
import { test } from "node:test";

import {
  aCsvExcel,
  aTabulado,
  armarReporte,
  estadosIniciales,
  faltantesDeEtiqueta,
  fechaCorta,
  filaDespachoLima,
  filaDespachoProvincia,
  puedeCambiarEstado,
  soles,
  terminoDeBusqueda,
  type Pedido,
} from "../src/lib/pedidos.ts";

function pedido(datos: Partial<Pedido>): Pedido {
  return {
    id: "1", codigo: "WED1", fecha_creacion: "", fecha_registro: "2026-11-24", monto: 89.9,
    pedido: "3xsolubre", cliente: "Ana", direccion: "Av. Lima 123", dni: "12345678", provincia: "Lima",
    distrito: "Surco", celular: "987654321", destino: "Lima", estado: "CONFIRMADO", asesor: "MILTON",
    canal: null, envio: null, courier: null, costo_envio: null, inventario: null, tracking: "T1",
    clave: null, nota: null, adelanto: null, pago_completo: null, prox_llamada: null, tipo_cliente: null,
    tipo_venta: null, cerrado_por: null, comision: null, creado_por: null, asignado_a: null, encargado: null,
    fecha_estado: null, fecha_confirmado: null, fecha_salida: null, fecha_entregado: null, ultima_gestion: null,
    estado_etiqueta: null, fecha_etiqueta: null, estado_shalom: null, es_prueba: false, extra: {},
    ...datos,
  };
}

test("el asesor mueve libre entre los estados de gestión", () => {
  assert.equal(puedeCambiarEstado("asesor", "VOLVER A LLAMAR", "CONFIRMADO"), true);
  assert.equal(puedeCambiarEstado("asesor", "CONFIRMADO", "NC"), true);
  assert.equal(puedeCambiarEstado("asesor_temp", "COORDINACIÓN", "RECHAZADO"), true);
});

test("el asesor necesita permiso para entregar o para sacar un pedido en camino", () => {
  assert.equal(puedeCambiarEstado("asesor", "CONFIRMADO", "ENTREGADO"), false);
  assert.equal(puedeCambiarEstado("asesor", "EN TRÁNSITO", "CONFIRMADO"), false);
  assert.equal(puedeCambiarEstado("asesor", "ENTREGADO", "ENTREGADO"), true);
});

test("admin y encargado cambian cualquier estado", () => {
  assert.equal(puedeCambiarEstado("admin", "ENTREGADO", "VOLVER A LLAMAR"), true);
  assert.equal(puedeCambiarEstado("encargado", "CONFIRMADO", "EN TRÁNSITO"), true);
});

test("un asesor sólo puede crear pedidos en estados de gestión", () => {
  assert.deepEqual(estadosIniciales("asesor"), ["VOLVER A LLAMAR", "COORDINACIÓN", "CONFIRMADO", "NC", "RECHAZADO"]);
  assert.equal(estadosIniciales("admin").length, 10);
});

test("despacho Lima sale en el orden de la hoja de despacho", () => {
  const fila = filaDespachoLima(pedido({ nota: "tocar\ttimbre\n2 veces" }));
  assert.deepEqual(fila, ["WED1", "Ana", "987654321", "Surco", "Av. Lima 123", "89.90", "3xsolubre", "tocar timbre 2 veces"]);
});

test("despacho Provincia sale en el orden de la agencia", () => {
  assert.deepEqual(filaDespachoProvincia(pedido({})), ["WED1", "Ana", "Av. Lima 123", "12345678", "987654321", "T1"]);
});

test("avisa qué le falta a cada etiqueta", () => {
  assert.deepEqual(faltantesDeEtiqueta([pedido({ tracking: null }), pedido({ tracking: "", dni: null })]), [
    "2 sin tracking",
    "1 sin DNI",
  ]);
});

test("el reporte cuenta por asesor y por estado", () => {
  const reporte = armarReporte([
    pedido({ asesor: "MILTON", estado: "CONFIRMADO", monto: 10 }),
    pedido({ asesor: "MILTON", estado: "NC", monto: 20 }),
    pedido({ asesor: null, estado: "CONFIRMADO", monto: 5 }),
  ]);
  assert.equal(reporte.total, 3);
  assert.equal(reporte.monto, 35);
  assert.equal(reporte.porAsesor[0].asesor, "MILTON");
  assert.equal(reporte.porAsesor[0].total, 2);
  assert.equal(reporte.porAsesor[1].asesor, "SIN ASESOR");
  assert.deepEqual(reporte.porEstado[0], ["CONFIRMADO", 2]);
});

test("formatos para pegar en planillas", () => {
  assert.equal(aTabulado([["a", "b"], ["c", "d"]]), "a\tb\nc\td");
  assert.equal(aCsvExcel([["Ñandú", 'dijo "hola"']]), '﻿"Ñandú";"dijo ""hola"""');
  assert.equal(fechaCorta("2026-11-24"), "24/11/2026");
  assert.equal(soles(89.9), "S/ 89.90");
});

test("la búsqueda saca los comodines que romperían la consulta", () => {
  assert.equal(terminoDeBusqueda("  WED7649, %Juan_ "), "wed7649 juan");
});
