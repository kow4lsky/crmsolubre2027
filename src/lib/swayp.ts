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
