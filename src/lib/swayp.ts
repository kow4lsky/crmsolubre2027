/**
 * Swayp (motorizado de Lima): avisos de cambio de estado de las guías.
 *
 * Swayp manda un POST firmado cada vez que una guía cambia de estado. Este
 * módulo verifica la firma y decide qué hacer con el pedido del CRM. Es puro:
 * lo usa la ruta del webhook y lo prueba el runner de Node.
 * Documentación: https://www.swayp.co/co/docs/ (sección "Webhook firmado").
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Los estados de una guía de Swayp, por su código. */
export const ESTADOS_SWAYP: Record<string, string> = {
  "1": "Generada",
  "2": "Preparada",
  "3": "Por recolectar",
  "4": "Asignada",
  "5": "Reparto",
  "6": "Novedad",
  "7": "Entregada",
  "8": "Revisión",
  "9": "Cancelación",
  "10": "Cancelada",
  "11": "Indemnizada",
  "12": "Devolución confirmada",
};

/**
 * Swayp firma el cuerpo crudo con HMAC-SHA256 y lo manda en hexadecimal como
 * `x-swayp-signature: sha256=<hex>`.
 */
export function verificarFirmaSwayp(cuerpo: string, firma: string | null, secreto: string): boolean {
  if (!firma || !secreto) return false;
  const esperada = Buffer.from(`sha256=${createHmac("sha256", secreto).update(cuerpo, "utf8").digest("hex")}`);
  const recibida = Buffer.from(firma.trim());
  return recibida.length === esperada.length && timingSafeEqual(recibida, esperada);
}

export type AvisoSwayp = { order_number?: string | number; status?: string; status_code?: string | number; comment?: string };

/** El aviso, limpio. Null si no trae guía o código de estado. */
export function leerAvisoSwayp(aviso: AvisoSwayp): { guia: string; codigo: string; estado: string; comentario: string } | null {
  const guia = String(aviso.order_number ?? "").trim();
  const codigo = String(aviso.status_code ?? "").trim();
  if (!guia || !codigo) return null;
  return {
    guia,
    codigo,
    estado: ESTADOS_SWAYP[codigo] ?? (String(aviso.status ?? "").trim() || codigo),
    comentario: String(aviso.comment ?? "").trim(),
  };
}

const EN_GESTION = ["VOLVER A LLAMAR", "COORDINACIÓN", "CONFIRMADO", "NC"];

/**
 * El estado que toma el pedido del CRM con este aviso de Swayp, o null si no
 * cambia. Un estado cerrado no se reabre, salvo para marcarlo ENTREGADO: si el
 * motorizado lo entregó, lo entregó.
 */
export function estadoDelCrm(codigoSwayp: string, estadoActual: string): string | null {
  switch (codigoSwayp) {
    case "4":
    case "5":
      return EN_GESTION.includes(estadoActual) ? "EN TRÁNSITO" : null;
    case "7":
      return estadoActual === "ENTREGADO" || estadoActual === "DEPURADO" ? null : "ENTREGADO";
    case "8":
    case "12":
      return [...EN_GESTION, "EN TRÁNSITO", "EN OFICINA"].includes(estadoActual) ? "EN DEVOLUCIÓN" : null;
    default:
      // Generada, por recolectar, novedad, cancelada…: se anota, el estado no cambia.
      return null;
  }
}

/* --------------------------------------------- guías listadas por fecha */

export type GuiaSwayp = {
  guia: string;
  codigo: string;
  estado: string;
  /** El código del CRM ("WED236100") si la guía se creó con él (columna id). */
  idExterno: string;
  celular: string;
  costo: number | null;
  recaudo: number | null;
};

function valor(item: Record<string, unknown>, claves: string[]): string {
  for (const clave of claves) {
    const v = item[clave];
    if (v !== null && v !== undefined && typeof v !== "object" && String(v).trim()) return String(v).trim();
  }
  // Un nivel adentro (fullData puede traer el detalle anidado).
  for (const v of Object.values(item)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const adentro = valor(v as Record<string, unknown>, claves);
      if (adentro) return adentro;
    }
  }
  return "";
}

const aNumero = (texto: string) => {
  const n = Number(texto.replace(/[^\d.-]/g, ""));
  return texto && Number.isFinite(n) ? n : null;
};

/** Una guía de POST /v2/guias/dates → lo que usa el CRM. */
export function leerGuiaSwayp(item: Record<string, unknown>): GuiaSwayp {
  const telefono = valor(item, ["telefonoDestinatario", "telefono_destinatario", "telefono", "phone"]).replace(/\D/g, "");
  let codigo = valor(item, ["idEstado", "id_estado", "status_code", "estadoId", "codigoEstado"]);
  const nombre = valor(item, ["estado", "status", "nombreEstado", "estadoNombre"]);
  if (!codigo && /^\d+$/.test(nombre)) codigo = nombre;
  if (!codigo) codigo = Object.entries(ESTADOS_SWAYP).find(([, n]) => n.toLowerCase() === nombre.toLowerCase())?.[0] ?? "";
  return {
    guia: valor(item, ["guia", "numeroGuia", "numero_guia", "guide", "guide_number", "order_number"]),
    codigo,
    estado: ESTADOS_SWAYP[codigo] ?? nombre,
    idExterno: valor(item, ["id", "idExterno", "id_externo", "idPedido", "referencia", "orderId"]).toUpperCase(),
    celular: telefono.length > 9 ? telefono.slice(-9) : telefono,
    costo: aNumero(valor(item, ["valorFlete", "flete", "costoEnvio"])),
    recaudo: aNumero(valor(item, ["valorRecaudo", "recaudo"])),
  };
}
