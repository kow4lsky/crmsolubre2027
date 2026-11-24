/**
 * Lee la pestaña BASE_SHOPIFY del Google Sheet (descargada como CSV): los
 * pedidos de Shopify que el CRM anterior ponía en "Pedidos pendientes". Esa
 * pestaña no tiene títulos ni código WED: cada fila es un pedido de Shopify
 * con su número en la columna A.
 *
 * Cuando el CRM anterior atendía uno, al lead le dejaba en NOTA la marca
 * "Origen Shopify: <número>". Con esa marca se sabe cuáles ya se atendieron.
 */

import { productoDelCatalogo } from "./pedidos.ts";
import { leerCelular, leerMomento, leerMonto, normalizarTitulo } from "./importar-pedidos.ts";

/** Las columnas de BASE_SHOPIFY (desde 0), como las usaba el CRM anterior. */
const COLUMNA = {
  numero: 0,
  ingreso: 1,
  fecha: 2,
  monto: 3,
  producto: 4,
  cantidad: 5,
  envio: 7,
  nombre: 8,
  apellido: 9,
  cliente: 25,
  direccion: 26,
  dni: 27,
  provincia: 28,
  distrito: 29,
  celular: 30,
} as const;

export type PedidoDeShopify = {
  /** El número de Shopify, sin "#": "23704", "D2505". */
  origen: string;
  /** Fecha y hora en Lima, o null si no se entiende. */
  fecha: string | null;
  cliente: string;
  celular: string | null;
  direccion: string | null;
  dni: string | null;
  provincia: string | null;
  distrito: string | null;
  destino: "Lima" | "Provincia" | null;
  monto: number | null;
  producto: string;
  cantidad: number;
  envio: string;
};

export type LecturaDeShopify = {
  pedidos: PedidoDeShopify[];
  /** Registrados antes de la fecha elegida. */
  fueraDeRango: number;
  /** El mismo número en dos filas: se usa la primera. */
  repetidos: number;
  error: string | null;
};

/** "#D2505" → "D2505"; " 23704 " → "23704". */
export function numeroDeShopify(valor: string): string {
  return valor.trim().replace(/^#+/, "").trim().toUpperCase();
}

/** La marca que deja el CRM en la nota del pedido. */
export function marcaDeOrigen(origen: string): string {
  return `Origen Shopify: ${origen}`;
}

function esNumeroDeShopify(valor: string) {
  return /^#?[A-Z]?\d{3,}$/i.test(valor.trim());
}

/** Fecha de la planilla → momento en Lima. Acepta "2026-09-30 03:15" y el ISO de la columna B. */
function leerFecha(local: string, iso: string): string | null {
  const desdeLocal = leerMomento(local);
  if (desdeLocal) return desdeLocal;
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso.trim())) {
    const fecha = new Date(iso.trim());
    if (!Number.isNaN(fecha.getTime())) return fecha.toISOString();
  }
  return leerMomento(iso);
}

/** El día en Lima ("2026-09-30") de un momento. */
export function diaDeLima(momento: string): string {
  const fecha = new Date(momento);
  return new Date(fecha.getTime() - 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function destinoDe(envio: string, provincia: string, distrito: string): "Lima" | "Provincia" | null {
  const e = normalizarTitulo(envio);
  if (e.includes("PROVINCIA")) return "Provincia";
  if (e.includes("LIMA") || e.includes("CALLAO")) return "Lima";
  const lugar = normalizarTitulo(`${provincia} ${distrito}`);
  if (!lugar) return null;
  return /\b(LIMA|CALLAO)\b/.test(lugar) ? "Lima" : "Provincia";
}

/** Las filas del CSV de BASE_SHOPIFY → pedidos. `desde` ("2026-11-01") deja afuera los anteriores. */
export function leerBaseShopify(filasCsv: string[][], desde: string | null = null): LecturaDeShopify {
  const lectura: LecturaDeShopify = { pedidos: [], fueraDeRango: 0, repetidos: 0, error: null };
  const vistos = new Set<string>();

  for (const celdas of filasCsv) {
    const celda = (i: number) => (celdas[i] ?? "").trim();
    // Una fila de títulos, si alguien la agregó, o una vacía: se salta.
    if (!esNumeroDeShopify(celda(COLUMNA.numero))) continue;

    const origen = numeroDeShopify(celda(COLUMNA.numero));
    if (vistos.has(origen)) {
      lectura.repetidos += 1;
      continue;
    }
    vistos.add(origen);

    const fecha = leerFecha(celda(COLUMNA.fecha), celda(COLUMNA.ingreso));
    if (desde && fecha && diaDeLima(fecha) < desde) {
      lectura.fueraDeRango += 1;
      continue;
    }

    const cliente =
      celda(COLUMNA.cliente) || [celda(COLUMNA.nombre), celda(COLUMNA.apellido)].filter(Boolean).join(" ") || "Cliente de Shopify";
    const provincia = celda(COLUMNA.provincia);
    const distrito = celda(COLUMNA.distrito);
    const envio = celda(COLUMNA.envio);
    const cantidad = leerMonto(celda(COLUMNA.cantidad));

    lectura.pedidos.push({
      origen,
      fecha,
      cliente,
      celular: leerCelular(celda(COLUMNA.celular)),
      direccion: celda(COLUMNA.direccion) || null,
      dni: celda(COLUMNA.dni) || null,
      provincia: provincia || null,
      distrito: distrito || null,
      destino: destinoDe(envio, provincia, distrito),
      monto: leerMonto(celda(COLUMNA.monto)),
      producto: celda(COLUMNA.producto),
      cantidad: cantidad && cantidad > 0 && cantidad <= 1000 && Number.isInteger(cantidad) ? cantidad : 1,
      envio,
    });
  }

  if (filasCsv.length > 0 && lectura.pedidos.length === 0 && lectura.fueraDeRango === 0) {
    lectura.error = "No encontré pedidos de Shopify. ¿Es la pestaña BASE_SHOPIFY de la planilla?";
  }
  return lectura;
}

/**
 * Los números de Shopify que ya tienen pedido en el CRM: por la marca
 * "Origen Shopify: …" de la nota (CRM anterior e importación) o por el pedido
 * que guarda el webhook de Shopify.
 */
export function numerosYaAtendidos(pedidosDelCrm: { nota?: string | null; extra?: Record<string, unknown> | null }[]): Map<string, number> {
  const atendidos = new Map<string, number>();
  const anotar = (numero: string) => {
    const limpio = numeroDeShopify(numero);
    if (limpio) atendidos.set(limpio, (atendidos.get(limpio) ?? 0) + 1);
  };
  for (const pedido of pedidosDelCrm) {
    for (const m of (pedido.nota ?? "").matchAll(/Origen Shopify:\s*#?\s*([A-Z]?\d+)/gi)) anotar(m[1]);
    const delWebhook = pedido.extra?.["SHOPIFY PEDIDO"];
    if (typeof delWebhook === "string") anotar(delWebhook);
  }
  return atendidos;
}

/** La fila de `pedidos` (sin código: lo pone la base) y sus productos. */
export function pedidoDesdeBaseShopify(
  p: PedidoDeShopify,
  opciones: { asesor: string; catalogo: string[]; ahora: Date },
) {
  const producto = productoDelCatalogo(p.producto, opciones.catalogo);
  const fecha = p.fecha ?? opciones.ahora.toISOString();
  const notas = [marcaDeOrigen(p.origen)];
  if (p.envio) notas.push(`Envío Shopify: ${p.envio}`);
  return {
    fila: {
      fecha_creacion: fecha,
      fecha_registro: diaDeLima(fecha),
      monto: p.monto ?? 0,
      pedido: p.producto ? `${p.cantidad}x${producto ?? p.producto}` : "",
      cliente: p.cliente,
      direccion: p.direccion,
      dni: p.dni,
      provincia: p.provincia,
      distrito: p.distrito,
      celular: p.celular,
      destino: p.destino,
      estado: "VOLVER A LLAMAR",
      canal: "SHOPIFY",
      asesor: opciones.asesor || null,
      asignado_a: opciones.asesor || null,
      // Para que aparezca ya en "para llamar": se pasó del CRM anterior.
      prox_llamada_at: opciones.ahora.toISOString(),
      nota: notas.join("\n"),
      extra: { "SHOPIFY PEDIDO": `#${p.origen}`, "SHOPIFY PRODUCTO": p.producto, "SHOPIFY ENVÍO": p.envio },
    },
    items: producto ? [{ producto, cantidad: p.cantidad }] : [],
  };
}
