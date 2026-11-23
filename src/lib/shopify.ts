/**
 * Pedidos de Shopify → pedidos del CRM.
 *
 * Shopify avisa con un webhook "Order creation" cada pedido nuevo: los de la
 * tienda y los de la landing de publicidad (el formulario de EasySell también
 * crea el pedido en Shopify). Este módulo verifica la firma y arma la fila de
 * `pedidos`. Es puro: lo usa la ruta del webhook y lo prueba el runner de Node.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { dayKeyInZone } from "./fechas.ts";

/** Tienda y landing entran con el mismo canal; el origen queda en extra. */
export const CANAL_SHOPIFY = "SHOPIFY";

/** Shopify firma el cuerpo con HMAC-SHA256 y lo manda en base64. */
export function verificarFirmaShopify(cuerpo: string, firma: string | null, secreto: string): boolean {
  if (!firma || !secreto) return false;
  const esperada = createHmac("sha256", secreto).update(cuerpo, "utf8").digest();
  let recibida: Buffer;
  try {
    recibida = Buffer.from(firma, "base64");
  } catch {
    return false;
  }
  return recibida.length === esperada.length && timingSafeEqual(recibida, esperada);
}

type Direccion = {
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  phone?: string | null;
  company?: string | null;
} | null;

export type PedidoShopify = {
  id: number | string;
  name?: string;
  created_at?: string;
  total_price?: string | number;
  financial_status?: string | null;
  tags?: string | null;
  source_name?: string | null;
  note?: string | null;
  note_attributes?: { name?: string; value?: unknown }[] | null;
  phone?: string | null;
  customer?: { first_name?: string | null; last_name?: string | null; phone?: string | null } | null;
  shipping_address?: Direccion;
  billing_address?: Direccion;
  line_items?: { title?: string | null; quantity?: number | null; variant_title?: string | null }[] | null;
  payment_gateway_names?: string[] | null;
};

const texto = (valor: unknown) => (valor === null || valor === undefined ? "" : String(valor).trim());
const normalizar = (valor: string) =>
  valor
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9Ñ]+/g, " ")
    .trim();

/** Celular de Perú: los últimos 9 dígitos. */
export function celularDe(valor: string): string | null {
  const digitos = valor.replace(/\D/g, "");
  if (!digitos) return null;
  return digitos.length > 9 ? digitos.slice(-9) : digitos;
}

/** Si el pedido vino de la landing (EasySell). La marca se busca en etiquetas, origen y atributos. */
export function esDeLanding(pedido: PedidoShopify, marca: string): boolean {
  const buscada = marca.trim().toLowerCase();
  if (!buscada) return false;
  const donde = [
    texto(pedido.tags),
    texto(pedido.source_name),
    ...(pedido.note_attributes ?? []).map((a) => `${texto(a.name)} ${texto(a.value)}`),
  ]
    .join(" ")
    .toLowerCase();
  return donde.includes(buscada);
}

/** El producto del catálogo que nombra un título de Shopify ("Solubre Limpieza para Pisos" → SOLUBRE). */
export function productoDelCatalogo(titulo: string, catalogo: string[]): string | null {
  const t = ` ${normalizar(titulo)} `;
  const candidatos = catalogo.filter((nombre) => t.includes(` ${normalizar(nombre)} `));
  // Si coinciden varios, el más largo: "CEPILLO DOBLE NEGRO" antes que "CEPILLO".
  return candidatos.sort((a, b) => b.length - a.length)[0] ?? null;
}

function atributo(pedido: PedidoShopify, patron: RegExp): string {
  const encontrado = (pedido.note_attributes ?? []).find((a) => patron.test(texto(a.name)));
  return encontrado ? texto(encontrado.value) : "";
}

export type OpcionesShopify = {
  /** Alias de la asesora que recibe los pedidos. */
  asesor: string;
  /** Qué palabra identifica un pedido de la landing. */
  marcaLanding: string;
  /** Los nombres del catálogo de productos del CRM. */
  catalogo: string[];
  zona?: string;
};

/** La fila de `pedidos` (sin workspace ni código: los pone la base) y sus productos. */
export function pedidoDesdeShopify(pedido: PedidoShopify, opciones: OpcionesShopify) {
  const envio = pedido.shipping_address ?? pedido.billing_address ?? null;
  const nombre =
    texto(envio?.name) ||
    [texto(envio?.first_name), texto(envio?.last_name)].filter(Boolean).join(" ") ||
    [texto(pedido.customer?.first_name), texto(pedido.customer?.last_name)].filter(Boolean).join(" ") ||
    "Cliente de Shopify";

  const celular = celularDe(
    texto(envio?.phone) || texto(pedido.billing_address?.phone) || texto(pedido.phone) || texto(pedido.customer?.phone),
  );

  // El DNI suele venir en un campo del formulario; si no, en "empresa".
  const dniCrudo = atributo(pedido, /dni|documento|ruc/i) || texto(envio?.company);
  const dni = /^\d{8,11}$/.test(dniCrudo.replace(/\D/g, "")) ? dniCrudo.replace(/\D/g, "") : null;

  const ciudad = texto(envio?.city);
  const region = texto(envio?.province);
  const lugar = normalizar(`${ciudad} ${region}`);
  const destino = /\b(LIMA|CALLAO)\b/.test(lugar) ? "Lima" : ciudad || region ? "Provincia" : null;

  const items = new Map<string, number>();
  const partes: string[] = [];
  for (const linea of pedido.line_items ?? []) {
    const titulo = texto(linea.title);
    const cantidad = Number(linea.quantity ?? 1) || 1;
    const producto = productoDelCatalogo(titulo, opciones.catalogo);
    if (producto) items.set(producto, (items.get(producto) ?? 0) + cantidad);
    partes.push(`${cantidad}x${producto ?? titulo}`);
  }

  const pagado = texto(pedido.financial_status).toLowerCase() === "paid";
  const creado = texto(pedido.created_at) || new Date().toISOString();
  const landing = esDeLanding(pedido, opciones.marcaLanding);

  return {
    fila: {
      shopify_id: texto(pedido.id),
      fecha_creacion: creado,
      fecha_registro: dayKeyInZone(creado, opciones.zona ?? "America/Lima"),
      monto: Number(pedido.total_price ?? 0) || 0,
      pedido: partes.join(", "),
      cliente: nombre,
      direccion: [texto(envio?.address1), texto(envio?.address2)].filter(Boolean).join(", ") || null,
      dni,
      provincia: ciudad || region || null,
      distrito: null as string | null,
      celular,
      destino,
      estado: pagado ? "CONFIRMADO" : "VOLVER A LLAMAR",
      pago_completo: pagado ? "SÍ" : null,
      canal: CANAL_SHOPIFY,
      asesor: opciones.asesor || null,
      asignado_a: opciones.asesor || null,
      nota: [`Shopify ${texto(pedido.name)}`.trim(), texto(pedido.note)].filter(Boolean).join(" · "),
      extra: {
        "SHOPIFY PEDIDO": texto(pedido.name),
        "SHOPIFY ORIGEN": landing ? "LANDING" : "TIENDA",
        "SHOPIFY PAGO": texto(pedido.financial_status),
        "SHOPIFY CIUDAD": ciudad,
        "SHOPIFY REGIÓN": region,
        "SHOPIFY ETIQUETAS": texto(pedido.tags),
      },
    },
    items: [...items.entries()].map(([producto, cantidad]) => ({ producto, cantidad })),
  };
}
