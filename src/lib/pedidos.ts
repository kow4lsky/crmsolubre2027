/**
 * Pedidos: tipos, estados, roles de venta y los formatos que se copian a otras
 * planillas (despacho, etiquetas, SMS).
 *
 * Sin `server-only` ni React: lo usan la pantalla y las pruebas por igual.
 * Las reglas de verdad están en Postgres (`202611230001_pedidos.sql`); esto
 * las refleja para que la pantalla no ofrezca lo que la base va a rechazar.
 */

export type RolVenta = "admin" | "encargado" | "asesor" | "asesor_temp";

export const ROLES_VENTA: RolVenta[] = ["admin", "encargado", "asesor", "asesor_temp"];

export const ROL_VENTA_LABELS: Record<RolVenta, string> = {
  admin: "Administrador",
  encargado: "Encargado",
  asesor: "Asesor",
  asesor_temp: "Asesor temporal",
};

export function esRolVenta(valor: unknown): valor is RolVenta {
  return typeof valor === "string" && (ROLES_VENTA as string[]).includes(valor);
}

/* ----------------------------------------------------------------- estados */

export const ESTADOS = [
  "VOLVER A LLAMAR",
  "COORDINACIÓN",
  "CONFIRMADO",
  "EN TRÁNSITO",
  "EN OFICINA",
  "ENTREGADO",
  "RECHAZADO",
  "NC",
  "EN DEVOLUCIÓN",
  "DEPURADO",
] as const;

export type Estado = (typeof ESTADOS)[number];

/** Los que un asesor mueve sin pedir permiso. Igual que `estado_libre()` en la base. */
export const ESTADOS_LIBRES: Estado[] = [
  "VOLVER A LLAMAR",
  "COORDINACIÓN",
  "CONFIRMADO",
  "NC",
  "RECHAZADO",
];

/** Los que ya no se gestionan. Una actualización automática nunca los reabre. */
export const ESTADOS_CERRADOS: Estado[] = ["ENTREGADO", "RECHAZADO", "NC", "EN DEVOLUCIÓN", "DEPURADO"];

export function esEstado(valor: unknown): valor is Estado {
  return typeof valor === "string" && (ESTADOS as readonly string[]).includes(valor);
}

/** Colores de la etiqueta de estado, como en la planilla. */
export const ESTADO_COLORES: Record<Estado, string> = {
  "VOLVER A LLAMAR": "bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300",
  COORDINACIÓN: "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300",
  CONFIRMADO: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  "EN TRÁNSITO": "bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300",
  "EN OFICINA": "bg-cyan-100 text-cyan-800 dark:bg-cyan-500/15 dark:text-cyan-300",
  ENTREGADO: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  RECHAZADO: "bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300",
  NC: "bg-neutral-200 text-neutral-700 dark:bg-white/10 dark:text-neutral-300",
  "EN DEVOLUCIÓN": "bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300",
  DEPURADO: "bg-neutral-100 text-neutral-500 dark:bg-white/5 dark:text-neutral-400",
};

/**
 * Si alguien con ese rol puede pasar un pedido de un estado a otro sin pedir
 * permiso. Admin y encargado pueden todo; el asesor, sólo entre los libres.
 */
export function puedeCambiarEstado(rol: RolVenta, de: string, a: string): boolean {
  if (de === a) return true;
  if (rol === "admin" || rol === "encargado") return true;
  return (ESTADOS_LIBRES as string[]).includes(de) && (ESTADOS_LIBRES as string[]).includes(a);
}

/** Los estados con los que puede nacer un pedido según quién lo carga. */
export function estadosIniciales(rol: RolVenta): Estado[] {
  return rol === "admin" || rol === "encargado" ? [...ESTADOS] : [...ESTADOS_LIBRES];
}

/* --------------------------------------------------------------- opciones */

/** Las listas desplegables de la planilla. Se pueden ampliar sin tocar la base. */
export const OPCIONES = {
  destino: ["Lima", "Provincia"],
  canal: ["WASAP IA", "WEB", "SHOPIFY", "WASAP EMP", "REDES (Inst,Mess)"],
  envio: ["Express", "Indriver", "Prog.Normal", "Prov.Agencia"],
  courier: ["Olva", "Shalom", "Marvisur", "Swipe", "Solubre"],
  inventario: ["SOLUBRE", "SWAYP"],
  cerradoPor: ["ASESOR", "IA"],
  asesor: [
    "MILTON", "DIANA", "ESTEFANI", "XIMENA", "KATHYA", "PAMELA", "GERALDINE", "NATHALY",
    "YAHAIRA", "RENZO", "DIEGO", "SEBASTIAN",
  ],
} as const;

/** Cuántos pedidos trae cada página de la tabla. */
export const PEDIDOS_POR_PAGINA = 100;

/** Las columnas que pide la tabla y el formulario. */
export const COLUMNAS_PEDIDO =
  "id, codigo, fecha_creacion, fecha_registro, monto, pedido, cliente, direccion, dni, provincia, distrito, celular, destino, estado, asesor, canal, envio, courier, costo_envio, inventario, tracking, clave, nota, adelanto, pago_completo, prox_llamada, tipo_cliente, tipo_venta, cerrado_por, comision, creado_por, asignado_a, encargado, fecha_estado, fecha_confirmado, fecha_salida, fecha_entregado, ultima_gestion, estado_etiqueta, fecha_etiqueta, estado_shalom, es_prueba, extra";

/* ------------------------------------------------------------------ tipos */

export type Pedido = {
  id: string;
  codigo: string;
  fecha_creacion: string;
  fecha_registro: string;
  monto: number;
  pedido: string;
  cliente: string;
  direccion: string | null;
  dni: string | null;
  provincia: string | null;
  distrito: string | null;
  celular: string | null;
  destino: string | null;
  estado: Estado;
  asesor: string | null;
  canal: string | null;
  envio: string | null;
  courier: string | null;
  costo_envio: number | null;
  inventario: string | null;
  tracking: string | null;
  clave: string | null;
  nota: string | null;
  adelanto: number | null;
  pago_completo: string | null;
  prox_llamada: string | null;
  tipo_cliente: string | null;
  tipo_venta: string | null;
  cerrado_por: string | null;
  comision: number | null;
  creado_por: string | null;
  asignado_a: string | null;
  encargado: string | null;
  fecha_estado: string | null;
  fecha_confirmado: string | null;
  fecha_salida: string | null;
  fecha_entregado: string | null;
  ultima_gestion: string | null;
  estado_etiqueta: string | null;
  fecha_etiqueta: string | null;
  estado_shalom: string | null;
  es_prueba: boolean;
  extra: Record<string, unknown>;
};

export type PedidoItem = { producto: string; cantidad: number };

/* ---------------------------------------------------------------- formatos */

/** S/ 89.90 */
export function soles(valor: number | null | undefined): string {
  const numero = Number(valor ?? 0);
  return `S/ ${numero.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "2026-11-24" → "24/11/2026". Si no es una fecha, la devuelve como vino. */
export function fechaCorta(valor: string | null | undefined): string {
  if (!valor) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(valor);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : valor;
}

const limpiar = (valor: unknown) =>
  String(valor ?? "")
    .replace(/[\t\r\n]+/g, " ")
    .trim();

export const DESPACHO_LIMA_COLUMNAS = [
  "COD", "CLIENTE", "CELULAR", "DISTRITO", "DIRECCIÓN", "MONTO", "PEDIDO", "NOTA",
];

export function filaDespachoLima(p: Pedido): string[] {
  return [p.codigo, p.cliente, p.celular, p.distrito, p.direccion, Number(p.monto ?? 0).toFixed(2), p.pedido, p.nota].map(limpiar);
}

export const DESPACHO_PROVINCIA_COLUMNAS = ["COD", "CLIENTE", "DIRECCION", "DNI", "CELULAR", "TRACKING"];

export function filaDespachoProvincia(p: Pedido): string[] {
  return [p.codigo, p.cliente, p.direccion, p.dni, p.celular, p.tracking].map(limpiar);
}

export const ETIQUETA_COLUMNAS = ["TRACKING", "CLIENTE", "DNI", "DIRECCIÓN", "PEDIDO"];

export function filaEtiqueta(p: Pedido): string[] {
  return [p.tracking, p.cliente, p.dni, p.direccion, p.pedido].map(limpiar);
}

/** Qué le falta a cada pedido para imprimir la etiqueta. */
export function faltantesDeEtiqueta(pedidos: Pedido[]): string[] {
  const nombres = ["sin tracking", "sin cliente", "sin DNI", "sin dirección", "sin pedido"];
  const cuentas = [0, 0, 0, 0, 0];
  for (const p of pedidos) {
    filaEtiqueta(p).forEach((valor, i) => {
      if (!valor) cuentas[i] += 1;
    });
  }
  return cuentas.flatMap((n, i) => (n ? [`${n} ${nombres[i]}`] : []));
}

export const SMS_COLUMNAS = ["CLIENTE", "CELULAR", "TRACKING"];

export function filaSms(p: Pedido): string[] {
  return [p.cliente, p.celular, p.tracking].map(limpiar);
}

/** Texto separado por tabulaciones: se pega directo en Google Sheets o Excel. */
export function aTabulado(filas: string[][]): string {
  return filas.map((fila) => fila.map(limpiar).join("\t")).join("\n");
}

/** CSV con punto y coma y BOM: Excel en español lo abre con acentos y columnas bien. */
export function aCsvExcel(filas: string[][]): string {
  const celda = (valor: string) => `"${valor.replace(/"/g, '""')}"`;
  return "﻿" + filas.map((fila) => fila.map(celda).join(";")).join("\r\n");
}

/* ----------------------------------------------------------------- reporte */

export type ReporteAsesor = { asesor: string; total: number; estados: [string, number][] };

export type Reporte = {
  total: number;
  monto: number;
  porAsesor: ReporteAsesor[];
  porEstado: [string, number][];
};

const ordenarConteo = (a: [string, number], b: [string, number]) => b[1] - a[1] || a[0].localeCompare(b[0], "es");

/** El resumen de "Generar reporte": cuántos tiene cada asesor y en qué estado. */
export function armarReporte(pedidos: Pedido[]): Reporte {
  const asesores = new Map<string, Map<string, number>>();
  const estados = new Map<string, number>();
  let monto = 0;

  for (const p of pedidos) {
    const asesor = limpiar(p.asesor) || "SIN ASESOR";
    const estado = limpiar(p.estado) || "SIN ESTADO";
    monto += Number(p.monto ?? 0);
    if (!asesores.has(asesor)) asesores.set(asesor, new Map());
    const delAsesor = asesores.get(asesor)!;
    delAsesor.set(estado, (delAsesor.get(estado) ?? 0) + 1);
    estados.set(estado, (estados.get(estado) ?? 0) + 1);
  }

  const porAsesor = [...asesores.entries()]
    .map(([asesor, mapa]) => ({
      asesor,
      total: [...mapa.values()].reduce((s, n) => s + n, 0),
      estados: [...mapa.entries()].sort(ordenarConteo),
    }))
    .sort((a, b) => b.total - a.total || a.asesor.localeCompare(b.asesor, "es"));

  return {
    total: pedidos.length,
    monto,
    porAsesor,
    porEstado: [...estados.entries()].sort(ordenarConteo),
  };
}

/* ------------------------------------------------------------- búsqueda */

/**
 * Lo que se escribe en la caja de búsqueda, listo para un `ilike`. Se sacan
 * los comodines de Postgres y las comas (separan condiciones en un `.or()`).
 */
export function terminoDeBusqueda(texto: string): string {
  return texto
    .toLowerCase()
    .replace(/[%_,()\\*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* --------------------------------------------------- productos del pedido */

/** Las cantidades rápidas del desplegable. Más que eso va por "Otro monto". */
export const CANTIDADES_RAPIDAS = ["1", "2", "3", "4", "5"] as const;

/** Un renglón del formulario: producto, cantidad elegida y, si es "otro", la escrita. */
export type LineaDeProducto = { producto: string; cantidad: string; otra: string };

export const OTRA_CANTIDAD = "otro";

/** La cantidad de un renglón, o null si todavía no es válida. */
export function cantidadDeLinea(linea: LineaDeProducto): number | null {
  const texto = linea.cantidad === OTRA_CANTIDAD ? linea.otra : linea.cantidad;
  const numero = Number(String(texto).replace(",", ".").trim());
  return Number.isFinite(numero) && numero > 0 && Number.isInteger(numero) ? numero : null;
}

/** Los renglones → productos del pedido. Si un producto se repite, se suma. */
export function juntarLineas(lineas: LineaDeProducto[]): PedidoItem[] {
  const total = new Map<string, number>();
  for (const linea of lineas) {
    const cantidad = cantidadDeLinea(linea);
    if (!linea.producto || cantidad === null) continue;
    total.set(linea.producto, (total.get(linea.producto) ?? 0) + cantidad);
  }
  return [...total.entries()].map(([producto, cantidad]) => ({ producto, cantidad }));
}

/** Lo que ya lleva un pedido → renglones del formulario. */
export function lineasDe(items: PedidoItem[]): LineaDeProducto[] {
  return items.map(({ producto, cantidad }) => {
    const texto = String(Number(cantidad));
    const rapida = (CANTIDADES_RAPIDAS as readonly string[]).includes(texto);
    return { producto, cantidad: rapida ? texto : OTRA_CANTIDAD, otra: rapida ? "" : texto };
  });
}

/** "3xSOLUBRE, 1xCEPILLO VERDE": la línea de resumen que se ve en la tabla. */
export function resumenDeProductos(items: PedidoItem[]): string {
  return items.map(({ producto, cantidad }) => `${Number(cantidad)}x${producto}`).join(", ");
}

/**
 * Si un pedido ya salió del inventario.
 *
 * Lima: recién cuando está ENTREGADO. Provincia: desde que sale a la agencia
 * (EN TRÁNSITO); sigue contando en EN OFICINA y ENTREGADO, porque el paquete
 * ya no está en el almacén. Sin destino se trata como Lima.
 */
export function saleDeInventario(destino: string | null, estado: string): boolean {
  const esProvincia = (destino ?? "").trim().toUpperCase().startsWith("PROV");
  if (esProvincia) return estado === "EN TRÁNSITO" || estado === "EN OFICINA" || estado === "ENTREGADO";
  return estado === "ENTREGADO";
}
