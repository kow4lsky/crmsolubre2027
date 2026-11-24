/**
 * Registro masivo de envíos a provincia: arma, desde los pedidos del CRM, la
 * plantilla Excel que Shalom acepta en su "registro masivo".
 *
 * Las reglas son las mismas que se usaban a mano:
 *   - caja: se cuentan sólo los productos principales (SOLUBRE, LIMPIAXPRESS,
 *     MILDREW), sin accesorios. 1 o 2 → PAQUETE S; 3 o más → PAQUETE M.
 *   - origen: la agencia de Lince (AV JOSE LEAL CDRA 6).
 *   - destino: la agencia que nombra la dirección del pedido.
 *
 * Es puro (sin navegador): lo prueba el runner de Node.
 */

import { ORIGEN_SHALOM } from "./agencias-shalom.ts";

export const PRODUCTOS_PRINCIPALES = ["SOLUBRE", "LIMPIAXPRESS", "MILDREW"];

export type CajaShalom = "PAQUETE S" | "PAQUETE M";

/** Las medidas que la plantilla de Shalom pone para cada caja (metros y kilos). */
export const MEDIDAS_SHALOM: Record<CajaShalom, { alto: number; ancho: number; largo: number; peso: number }> = {
  "PAQUETE S": { alto: 0.3, ancho: 0.3, largo: 0.12, peso: 2 },
  "PAQUETE M": { alto: 0.3, ancho: 0.24, largo: 0.2, peso: 5 },
};

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9Ñ]+/g, " ")
    .trim();
}

/** "3xsolubre, 1xcv, 2 x Limpiaxpress" → 5 productos principales. */
export function productosPrincipales(pedido: string): number {
  let total = 0;
  for (const parte of pedido.split(/[,;+\n]/)) {
    const m = /(\d+)\s*[xX×]\s*(.+)/.exec(parte.trim());
    if (!m) continue;
    const nombre = normalizar(m[2]);
    if (PRODUCTOS_PRINCIPALES.some((p) => nombre.includes(p))) total += Number(m[1]);
  }
  return total;
}

export function cajaShalom(principales: number): CajaShalom {
  return principales >= 3 ? "PAQUETE M" : "PAQUETE S";
}

/** Palabras que no ayudan a reconocer una agencia. */
const VACIAS = new Set([
  "AV", "AVENIDA", "JR", "JIRON", "CALLE", "CA", "CAL", "CDRA", "CUADRA", "NRO", "N", "NO", "DE", "DEL", "LA", "EL", "LOS",
  "LAS", "Y", "AGENCIA", "SHALOM", "TIENDA", "SEDE", "OFICINA", "CO", "PROVINCIA", "DISTRITO", "DPTO", "DEPARTAMENTO",
]);

function palabras(texto: string): string[] {
  return normalizar(texto)
    .split(" ")
    // Los números (cuadras, Nº) casi nunca los escribe el cliente.
    .filter((p) => p && !VACIAS.has(p) && !/^\d+$/.test(p));
}

export type Sugerencia = {
  agencia: string | null;
  /** true si todas las palabras de la agencia están en la dirección. */
  segura: boolean;
  candidatas: string[];
};

/**
 * La agencia de Shalom que nombra la dirección (y el distrito/provincia) del
 * pedido. Se propone la mejor si no empata con otra y coincide al menos la
 * mitad de sus palabras; `segura` dice si coincidieron todas. Si no, quedan
 * las candidatas para que la persona elija.
 */
export function sugerirAgencia(texto: string, agencias: readonly string[]): Sugerencia {
  const delPedido = new Set(palabras(texto));
  const frase = ` ${normalizar(texto)} `;
  const puntajes: { agencia: string; puntaje: number; completas: number }[] = [];
  for (const agencia of agencias) {
    const suyas = palabras(agencia);
    if (suyas.length === 0) continue;
    const coinciden = suyas.filter((p) => delPedido.has(p)).length;
    if (coinciden === 0) continue;
    const completa = coinciden === suyas.length;
    // La frase entera de la agencia dentro de la dirección pesa más.
    const frasePropia = frase.includes(` ${suyas.join(" ")} `);
    puntajes.push({ agencia, puntaje: coinciden / suyas.length + (frasePropia ? 1 : 0), completas: completa ? suyas.length : 0 });
  }
  puntajes.sort((a, b) => b.puntaje - a.puntaje || b.completas - a.completas || a.agencia.localeCompare(b.agencia));
  const mejor = puntajes[0];
  const empatados = puntajes.filter((p) => mejor && p.puntaje === mejor.puntaje && p.completas === mejor.completas);
  // Con dos agencias igual de buenas no se adivina: elige la persona.
  const propuesta = mejor && mejor.puntaje >= 0.5 && empatados.length === 1 ? mejor : null;
  return {
    agencia: propuesta?.agencia ?? null,
    segura: !!propuesta && propuesta.completas > 0,
    candidatas: puntajes.slice(0, 8).map((p) => p.agencia),
  };
}

export type FilaShalom = { documento: string; telefono: string; destino: string; caja: CajaShalom; cantidad?: number };

/** Lo que le falta a una fila para que Shalom la acepte. Vacío = está bien. */
export function problemasDeFilaShalom(fila: FilaShalom, agencias: readonly string[]): string[] {
  const problemas: string[] = [];
  const doc = fila.documento.replace(/\D/g, "");
  if (doc.length !== 8 && doc.length !== 11) problemas.push("DNI de 8 dígitos (o RUC de 11)");
  if (!/^9\d{8}$/.test(fila.telefono.replace(/\D/g, ""))) problemas.push("celular de 9 dígitos");
  if (!agencias.includes(fila.destino)) problemas.push("agencia de destino");
  return problemas;
}

/* ------------------------------------------------------ la hoja de Excel */

const PRIMERA_FILA = 2;
export const MAXIMO_DE_FILAS_SHALOM = 498;

function escaparXml(texto: string): string {
  return texto.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function celda(ref: string, estilo: string | null, valor: string | number | null): string {
  const s = estilo ? ` s="${estilo}"` : "";
  if (valor === null || valor === "") return `<c r="${ref}"${s}/>`;
  if (typeof valor === "number") return `<c r="${ref}"${s}><v>${valor}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t>${escaparXml(valor)}</t></is></c>`;
}

/** Reemplaza (o agrega) una celda de una fila, conservando su estilo. */
function ponerCelda(filaXml: string, ref: string, valor: string | number | null): string {
  const patron = new RegExp(`<c r="${ref}"((?:\\s+[\\w:]+="[^"]*")*)\\s*(?:/>|>[\\s\\S]*?</c>)`);
  const existente = patron.exec(filaXml);
  if (existente) {
    const estilo = /\bs="([^"]*)"/.exec(existente[1])?.[1] ?? null;
    return filaXml.replace(patron, celda(ref, estilo, valor));
  }
  return filaXml.replace("</row>", `${celda(ref, null, valor)}</row>`);
}

/**
 * La hoja 1 de la plantilla de Shalom con los envíos puestos desde la fila 2.
 * Las medidas van como número (no como fórmula) para que Shalom las lea aunque
 * el Excel no se haya recalculado.
 */
export function llenarHojaShalom(hojaXml: string, filas: FilaShalom[]): string {
  // La fila 2 trae un ejemplo de Shalom: siempre se pisa con el primer envío.
  if (filas.length === 0) throw new Error("No hay envíos para poner en la plantilla.");
  if (filas.length > MAXIMO_DE_FILAS_SHALOM) {
    throw new Error(`La plantilla de Shalom acepta hasta ${MAXIMO_DE_FILAS_SHALOM} envíos por archivo.`);
  }
  let xml = hojaXml;
  filas.forEach((fila, i) => {
    const r = PRIMERA_FILA + i;
    const patronFila = new RegExp(`<row r="${r}"[^>]*>[\\s\\S]*?</row>|<row r="${r}"[^>]*/>`);
    let filaXml = patronFila.exec(xml)?.[0];
    if (!filaXml) throw new Error(`La plantilla no tiene la fila ${r}.`);
    if (filaXml.endsWith("/>")) filaXml = filaXml.replace(/\/>$/, "></row>");
    const medidas = MEDIDAS_SHALOM[fila.caja];
    const doc = fila.documento.replace(/\D/g, "");
    const tel = fila.telefono.replace(/\D/g, "");
    const valores: Record<string, string | number | null> = {
      A: doc ? Number(doc) : null,
      B: tel ? Number(tel) : null,
      C: null,
      D: null,
      E: null,
      F: ORIGEN_SHALOM,
      G: fila.destino,
      H: fila.caja,
      I: medidas.alto,
      J: medidas.ancho,
      K: medidas.largo,
      L: medidas.peso,
      M: fila.cantidad ?? 1,
    };
    let nueva = filaXml;
    for (const [col, valor] of Object.entries(valores)) nueva = ponerCelda(nueva, `${col}${r}`, valor);
    xml = xml.replace(patronFila, nueva);
  });

  return xml;
}
