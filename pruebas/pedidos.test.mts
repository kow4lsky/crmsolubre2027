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

test("los renglones de productos se juntan y arman el resumen", async () => {
  const { juntarLineas, resumenDeProductos, lineasDe, cantidadDeLinea } = await import("../src/lib/pedidos.ts");
  const items = juntarLineas([
    { producto: "SOLUBRE", cantidad: "2", otra: "" },
    { producto: "CEPILLO VERDE", cantidad: "otro", otra: "12" },
    { producto: "SOLUBRE", cantidad: "1", otra: "" },
    { producto: "", cantidad: "3", otra: "" },
    { producto: "PAÑO", cantidad: "otro", otra: "" },
  ]);
  assert.deepEqual(items, [
    { producto: "SOLUBRE", cantidad: 3 },
    { producto: "CEPILLO VERDE", cantidad: 12 },
  ]);
  assert.equal(resumenDeProductos(items), "3xSOLUBRE, 12xCEPILLO VERDE");
  assert.deepEqual(lineasDe([{ producto: "PAÑO", cantidad: 4 }, { producto: "CAJAS", cantidad: 20 }]), [
    { producto: "PAÑO", cantidad: "4", otra: "" },
    { producto: "CAJAS", cantidad: "otro", otra: "20" },
  ]);
  assert.equal(cantidadDeLinea({ producto: "X", cantidad: "otro", otra: "1.5" }), null);
});

test("un pedido sale del inventario: Lima al entregar, Provincia desde EN TRÁNSITO", async () => {
  const { saleDeInventario } = await import("../src/lib/pedidos.ts");
  assert.equal(saleDeInventario("Lima", "EN TRÁNSITO"), false);
  assert.equal(saleDeInventario("Lima", "ENTREGADO"), true);
  assert.equal(saleDeInventario(null, "CONFIRMADO"), false);
  assert.equal(saleDeInventario("Provincia", "CONFIRMADO"), false);
  assert.equal(saleDeInventario("Provincia", "EN TRÁNSITO"), true);
  assert.equal(saleDeInventario("Provincia", "ENTREGADO"), true);
  assert.equal(saleDeInventario("Provincia", "RECHAZADO"), false);
});

test("inventario, envío y courier van de la mano", async () => {
  const { enviosPara, courierPara, ajustarEntrega, errorDeEntrega } = await import("../src/lib/pedidos.ts");
  assert.deepEqual(enviosPara("SWAYP"), ["Express", "Prog.Normal"]);
  assert.deepEqual(enviosPara("SOLUBRE"), ["Indriver", "Prov.Agencia"]);
  assert.deepEqual(enviosPara(""), []);
  assert.deepEqual(courierPara("SWAYP", "Express"), { opciones: ["Swayp"], fijo: "Swayp" });
  assert.deepEqual(courierPara("SOLUBRE", "Indriver"), { opciones: ["Solubre"], fijo: "Solubre" });
  assert.deepEqual(courierPara("SOLUBRE", "Prov.Agencia").opciones, ["Shalom", "Olva", "Marvisur"]);

  // Cambiar de SOLUBRE a SWAYP vacía el envío y pone Swayp solo.
  assert.deepEqual(ajustarEntrega({ inventario: "SWAYP", envio: "Indriver", courier: "Solubre" }), {
    inventario: "SWAYP", envio: "", courier: "Swayp",
  });
  assert.deepEqual(ajustarEntrega({ inventario: "SOLUBRE", envio: "Prov.Agencia", courier: "Olva" }), {
    inventario: "SOLUBRE", envio: "Prov.Agencia", courier: "Olva",
  });
  assert.equal(errorDeEntrega({ inventario: "SOLUBRE", envio: "Express", courier: "" })?.startsWith("El envío Express"), true);
  assert.equal(errorDeEntrega({ inventario: "SOLUBRE", envio: "Prov.Agencia", courier: "Swayp" })?.startsWith("El courier"), true);
  assert.equal(errorDeEntrega({ inventario: "", envio: "Express", courier: "x" }), null);
});

test("un pedido CONFIRMADO necesita inventario, envío y courier", async () => {
  const { faltaParaEstado } = await import("../src/lib/pedidos.ts");
  const vacio = { celular: "", destino: "", inventario: "", envio: "", courier: "" };
  assert.equal(
    faltaParaEstado({ estado: "CONFIRMADO", ...vacio }),
    "Para dejarlo CONFIRMADO completa: Celular, Destino, Inventario, Envío, Courier.",
  );
  assert.equal(
    faltaParaEstado({ estado: "CONFIRMADO", celular: "987654321", destino: "Provincia", inventario: "SOLUBRE", envio: "Prov.Agencia", courier: "" }),
    "Para dejarlo CONFIRMADO completa: Courier.",
  );
  assert.equal(
    faltaParaEstado({ estado: "CONFIRMADO", celular: "987654321", destino: "Lima", inventario: "SWAYP", envio: "Express", courier: "Swayp" }),
    null,
  );
  assert.equal(faltaParaEstado({ estado: "NC", ...vacio }), null);
});

test("las secciones de cada persona", async () => {
  const { seccionesDe, seccionesPorDefecto } = await import("../src/lib/secciones.ts");
  assert.deepEqual(seccionesPorDefecto("asesor"), ["Pedidos", "Autorizaciones", "Tareas"]);
  assert.equal(seccionesPorDefecto("admin").length, 9);
  assert.deepEqual(seccionesDe(null, "encargado"), ["Pedidos", "Autorizaciones", "Tareas"]);
  // Lo que no es una sección asignable se descarta (Configuración es sólo del admin).
  assert.deepEqual(seccionesDe(["Pedidos", "Configuración", 3, "Agenda"], "asesor"), ["Pedidos", "Agenda"]);
  assert.deepEqual(seccionesDe([], "asesor"), []);
});

test("la próxima llamada se guarda y se muestra en hora de Lima", async () => {
  const { momentoDeLima, aLocalDeLima, fechaYHoraDeLima } = await import("../src/lib/pedidos.ts");
  assert.equal(momentoDeLima("2026-11-24T15:30"), "2026-11-24T15:30:00-05:00");
  assert.equal(momentoDeLima(""), null);
  // Lo que guarda la base (en UTC) vuelve a ser las 15:30 de Lima, sin importar la hora de la compu.
  assert.equal(aLocalDeLima("2026-11-24T20:30:00+00:00"), "2026-11-24T15:30");
  assert.equal(aLocalDeLima("2026-11-25T02:10:00Z"), "2026-11-24T21:10");
  assert.equal(fechaYHoraDeLima("2026-11-24T20:30:00Z"), "24/11/2026 15:30");
  assert.equal(aLocalDeLima(null), "");
});

test("VOLVER A LLAMAR y COORDINACIÓN exigen programar la próxima llamada", async () => {
  const { faltaParaEstado } = await import("../src/lib/pedidos.ts");
  const vacio = { celular: "", destino: "", inventario: "", envio: "", courier: "" };
  assert.equal(
    faltaParaEstado({ estado: "VOLVER A LLAMAR", ...vacio, proxLlamada: "" }),
    "Para dejarlo VOLVER A LLAMAR programa la próxima llamada (fecha y hora).",
  );
  assert.equal(
    faltaParaEstado({ estado: "COORDINACIÓN", ...vacio, proxLlamada: "2026-11-25" }),
    "Para dejarlo COORDINACIÓN programa la próxima llamada (fecha y hora).",
  );
  assert.equal(faltaParaEstado({ estado: "COORDINACIÓN", ...vacio, proxLlamada: "2026-11-25T16:00" }), null);
  assert.equal(faltaParaEstado({ estado: "RECHAZADO", ...vacio }), null);
});
