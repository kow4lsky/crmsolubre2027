/**
 * Llamadas: los leads que entraron hoy a Flujos, para que una asesora llame a
 * los que todavía no se cierran. Es puro: lo usa el servidor al traerlos y lo
 * prueba el runner de Node.
 */
import { primero } from "./flujos.ts";
import { productoDelCatalogo } from "./pedidos.ts";

export type LeadDeLlamada = {
  lead_id: string;
  nombre: string;
  celular: string | null;
  producto: string | null;
  etapa: string;
  etiquetas: string[];
  anuncio: string | null;
  creado_en: string;
};

/** Los nombres de las etapas de Flujos (pipeline_stages_list). */
export const ETAPAS_FLUJOS: Record<string, string> = {
  "mensajes-entrantes": "Mensajes entrantes",
  interacciones: "Interacciones",
  "compromiso-pago": "Compromiso de pago",
  "en-seguimiento": "En seguimiento",
  "transferidos-humano": "Transferido a humano",
  descartado: "Descartado",
  "ventas-concretadas": "Venta concretada",
  "pedidos-entrantes": "Pedido entrante",
  "no-responde-24h": "No responde (24h)",
  "en-interaccion": "En interacción",
  "en-seguimiento-conf": "En seguimiento",
  "compromiso-pago-conf": "Compromiso de pago",
  "transferidos-humano-conf": "Transferido a humano",
  "descartados-conf": "Descartado",
  confirmados: "Confirmado",
};

/** Las etapas en las que el lead ya se cerró (vendió o confirmó). */
const CERRADAS = new Set(["ventas-concretadas", "confirmados", "pedidos-entrantes", "por-registrar", "por-enviar", "registrado", "en-transito"]);

export function estaCerrado(etapa: string): boolean {
  return CERRADAS.has(etapa);
}

export const etiquetaDeEtapa = (etapa: string) => ETAPAS_FLUJOS[etapa] ?? etapa.replace(/-/g, " ");

/** "#limpiaxpress te ayuda…" → LIMPIAXPRESS, si está en el catálogo. */
export function productoDelLead(lead: Record<string, unknown>, catalogo: string[]): string | null {
  const anuncio = lead.anuncio && typeof lead.anuncio === "object" ? (lead.anuncio as Record<string, unknown>) : {};
  // Primero el texto del anuncio: el título suele ser la marca ("Solubre Limpieza").
  const textos = [anuncio.body, lead.summary, anuncio.headline]
    .map((t) => String(t ?? "").replace(/#/g, " "))
    .filter(Boolean);
  for (const texto of textos) {
    const producto = productoDelCatalogo(texto, catalogo);
    if (producto) return producto;
  }
  return null;
}

/** Un lead de `leads_list` → la fila de la tabla de llamadas. */
export function leadDeLlamada(lead: Record<string, unknown>, etiquetas: Map<string, string>, catalogo: string[]): LeadDeLlamada | null {
  const id = String(lead.id ?? "").trim();
  if (!id) return null;
  const crudo = primero(lead, ["phone", "telefono", "phone_number", "whatsapp", "whatsapp_number", "celular", "wa_id", "contact_phone"]).replace(/\D/g, "");
  const celular = crudo.length >= 9 ? crudo.slice(-9) : null;
  const tags = Array.isArray(lead.tags) ? lead.tags : [];
  const anuncio = lead.anuncio && typeof lead.anuncio === "object" ? String((lead.anuncio as Record<string, unknown>).headline ?? "") : "";
  return {
    lead_id: id,
    nombre: String(lead.name ?? lead.whatsapp_name ?? "").trim() || "Sin nombre",
    celular,
    producto: productoDelLead(lead, catalogo),
    etapa: String(lead.stage ?? ""),
    etiquetas: tags
      .map((t) => (t && typeof t === "object" ? String((t as Record<string, unknown>).name ?? (t as Record<string, unknown>).id ?? "") : String(t)))
      .map((t) => etiquetas.get(t) ?? t)
      .filter(Boolean),
    anuncio: anuncio.trim() || null,
    creado_en: String(lead.created_at ?? new Date().toISOString()),
  };
}

export const LLAMADAS = [
  { valor: "PRIMERA", texto: "1ra llamada" },
  { valor: "SEGUNDA", texto: "2da llamada" },
  { valor: "NC", texto: "NC" },
] as const;
export type Llamada = (typeof LLAMADAS)[number]["valor"];
