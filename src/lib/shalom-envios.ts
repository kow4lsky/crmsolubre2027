/**
 * Lo que devuelve Shalom PRO de cada envío → los datos del CRM.
 *
 * Shalom PRO no tiene API pública: el CRM usa las mismas llamadas que su web
 * (registro masivo, envíos pendientes, historial), con la sesión que la
 * persona abrió en su navegador. Los nombres de los campos se leen con
 * varias variantes porque no están documentados.
 *
 * Es puro: lo prueba el runner de Node.
 */

import type { Estado } from "./pedidos.ts";

export type EnvioShalom = {
  /** N° de orden: "103397868". */
  orden: string;
  /** Código de la orden: "3PCT". */
  codigo: string;
  dni: string;
  /** en_origen, en_transito, en_reparto, en_destino, entregado, devuelto. */
  estado: string;
  costo: number | null;
  destino: string;
};

function texto(valor: unknown): string {
  return valor === null || valor === undefined ? "" : String(valor).trim();
}

/** El primer valor con texto. Una clave puede ir con punto: "receiver.document". */
function primero(item: Record<string, unknown>, claves: string[]): string {
  for (const clave of claves) {
    let valor: unknown = item;
    for (const parte of clave.split(".")) valor = valor && typeof valor === "object" ? (valor as Record<string, unknown>)[parte] : undefined;
    if (valor && typeof valor === "object") continue;
    const limpio = texto(valor);
    if (limpio) return limpio;
  }
  return "";
}

function numero(valor: string): number | null {
  const n = Number(valor.replace(/[^\d.,-]/g, "").replace(",", "."));
  return valor && Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** Un envío como lo devuelve Shalom PRO → lo que usa el CRM. */
export function leerEnvioShalom(item: Record<string, unknown>): EnvioShalom {
  return {
    orden: primero(item, ["service_order_id_empresarial", "serviceOrderIdEmpresarial", "order_number", "numero_orden", "ose_id"]),
    codigo: primero(item, ["code_service_order_empresarial", "codeServiceOrderEmpresarial", "code", "codigo"]),
    // En Rastreo e Historial el DNI viene adentro del destinatario.
    dni: primero(item, [
      "receiver.document",
      "receiver_person.document",
      "recipient_dni",
      "document_number",
      "doc_consignatario",
      "receiver_document",
    ]).replace(/\D/g, ""),
    estado: primero(item, ["status", "shipping_status"]).toLowerCase() || "en_origen",
    costo: numero(primero(item, ["price", "total", "amount", "precio", "monto", "detail_service.0.type_product.value"])),
    destino: primero(item, [
      "destination.name",
      "destination.ter_nombre",
      "destination_station.name",
      "destination_station.ter_nombre",
      "destination",
      "destino",
      "ter_nombre",
    ]),
  };
}

/** "103397868 - 3PCT", como se escribía a mano en el CRM. */
export function trackingShalom(envio: Pick<EnvioShalom, "orden" | "codigo">): string {
  return envio.codigo ? `${envio.orden} - ${envio.codigo}` : envio.orden;
}

/** El N° de orden que está al principio del tracking ("103397868 - 3PCT" → "103397868"). */
export function ordenDelTracking(tracking: string | null | undefined): string | null {
  return /^\s*(\d{5,})/.exec(tracking ?? "")?.[1] ?? null;
}

const ETIQUETAS: Record<string, string> = {
  en_origen: "EN ORIGEN",
  en_transito: "EN TRÁNSITO",
  en_reparto: "EN REPARTO",
  en_destino: "EN DESTINO",
  entregado: "ENTREGADO",
  devuelto: "DEVUELTO",
};

/** Lo que se muestra en la columna "Estado courier". */
export function etiquetaShalom(estado: string): string {
  return ETIQUETAS[estado] ?? estado.toUpperCase().replace(/_/g, " ");
}

/** Qué tan avanzado está un pedido en el CRM: nunca se lo hace retroceder. */
const AVANCE: Partial<Record<Estado, number>> = {
  CONFIRMADO: 1,
  "EN TRÁNSITO": 2,
  "EN OFICINA": 3,
  ENTREGADO: 4,
  "EN DEVOLUCIÓN": 4,
};

/**
 * El estado del CRM que corresponde al de Shalom, o null si no hay que
 * cambiarlo. Sólo se mueve hacia adelante y nunca toca un pedido que no está
 * en camino (RECHAZADO, DEPURADO, etc.).
 */
export function estadoCrmDesdeShalom(estadoShalom: string, actual: Estado): Estado | null {
  const avanceActual = AVANCE[actual];
  if (!avanceActual) return null;
  const destino: Estado | null =
    estadoShalom === "en_transito" || estadoShalom === "en_reparto"
      ? "EN TRÁNSITO"
      : estadoShalom === "en_destino"
        ? "EN OFICINA"
        : estadoShalom === "entregado"
          ? "ENTREGADO"
          : estadoShalom === "devuelto"
            ? "EN DEVOLUCIÓN"
            : null;
  if (!destino || destino === actual) return null;
  // Una devolución sí puede venir después de EN OFICINA; entregado no se toca.
  if (actual === "ENTREGADO" || actual === "EN DEVOLUCIÓN") return null;
  return (AVANCE[destino] ?? 0) > avanceActual || destino === "EN DEVOLUCIÓN" ? destino : null;
}

/** El nombre de la cookie de sesión de Shalom PRO. */
export const COOKIE_DE_SESION = "enviashalom_session";

/**
 * La cookie de sesión de Shalom PRO tal como se copió → "nombre=valor".
 * Se acepta el valor solo (se toma como enviashalom_session), "nombre=valor"
 * o la línea entera de las cookies (se quedan la de sesión y la de
 * "Recuérdame", si la hay).
 */
export function cookieDeSesion(pegado: string): string | null {
  const limpio = pegado.trim().replace(/^cookie:\s*/i, "");
  if (!limpio) return null;
  const pares = limpio
    .split(/;\s*/)
    .map((p) => p.trim())
    .filter((p) => p.startsWith(`${COOKIE_DE_SESION}=`) || /^remember_web_[a-f0-9]+=/i.test(p));
  if (pares.length) return pares.join("; ");
  if (/^[^=\s;]+$/.test(limpio)) return `${COOKIE_DE_SESION}=${limpio}`;
  return null;
}

/**
 * De los envíos de Shalom, el que corresponde a cada pedido, por DNI. Si un
 * DNI aparece en más de un envío, se usa el de orden más alto (el último).
 */
export function emparejarPorDni<P extends { id: string; dni: string | null }>(
  pedidos: P[],
  envios: EnvioShalom[],
): Map<string, EnvioShalom> {
  const porDni = new Map<string, EnvioShalom>();
  for (const envio of envios) {
    if (!envio.dni || !envio.orden) continue;
    const previo = porDni.get(envio.dni);
    if (!previo || Number(envio.orden) > Number(previo.orden)) porDni.set(envio.dni, envio);
  }
  const resultado = new Map<string, EnvioShalom>();
  for (const pedido of pedidos) {
    const envio = porDni.get((pedido.dni ?? "").replace(/\D/g, ""));
    if (envio) resultado.set(pedido.id, envio);
  }
  return resultado;
}
