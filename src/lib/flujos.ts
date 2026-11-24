/**
 * Flujos Inteligentes (ventas por WhatsApp) → pedidos pendientes del CRM.
 *
 * El CRM lee los pedidos de Flujos por su servidor MCP "sin restricciones" y
 * se queda con los que cerró la IA. Este módulo traduce un pedido de Flujos a
 * los campos de un pedido del CRM. Los nombres de los campos se buscan con
 * varias variantes: el detalle completo no está documentado y puede cambiar.
 *
 * Es puro: lo usa la sincronización y lo prueba el runner de Node.
 */
import { dayKeyInZone } from "./fechas.ts";
import { productoDelCatalogo, resumenDeProductos, type PedidoItem } from "./pedidos.ts";

export type PedidoFlujos = Record<string, unknown>;

/** El primer valor no vacío entre varios nombres de campo, buscando también un nivel adentro. */
export function primero(objeto: unknown, claves: string[]): string {
  if (!objeto || typeof objeto !== "object") return "";
  const registro = objeto as Record<string, unknown>;
  for (const clave of claves) {
    const valor = registro[clave];
    if (valor !== null && valor !== undefined && typeof valor !== "object" && String(valor).trim()) {
      return String(valor).trim();
    }
  }
  for (const valor of Object.values(registro)) {
    if (valor && typeof valor === "object" && !Array.isArray(valor)) {
      const encontrado = primero(valor, claves);
      if (encontrado) return encontrado;
    }
  }
  return "";
}

/** Si la venta la cerró la IA. */
export function esDeIA(pedido: PedidoFlujos): boolean {
  const valor = pedido.created_by_ai ?? pedido.creado_por_ia ?? pedido.createdByAi;
  return valor === true || valor === "true" || valor === 1;
}

const numero = (texto: string) => {
  const n = Number(texto.replace(/[^\d.-]/g, ""));
  return texto && Number.isFinite(n) ? n : null;
};

/** Los productos del pedido de Flujos, si vienen detallados. */
export function productosDe(pedido: PedidoFlujos): { nombre: string; cantidad: number }[] {
  const lista = [pedido.productos, pedido.products, pedido.items, pedido.order_items].find(Array.isArray) as
    | Record<string, unknown>[]
    | undefined;
  if (!lista) return [];
  return lista
    .map((p) => ({
      nombre: primero(p, ["nombre", "name", "product_name", "title", "titulo", "producto"]),
      cantidad: Number(primero(p, ["cantidad", "quantity", "qty"]) || 1) || 1,
    }))
    .filter((p) => p.nombre);
}

/**
 * Los campos del pedido del CRM que salen de un pedido de Flujos. Es una
 * propuesta: quien lo programa la revisa en la ficha antes de guardar.
 */
export function propuestaDesdeFlujos(pedido: PedidoFlujos, catalogo: string[]) {
  const celularCrudo = primero(pedido, ["phone", "telefono", "lead_phone", "celular", "whatsapp", "customer_phone"]).replace(/\D/g, "");
  const celular = celularCrudo.length > 9 ? celularCrudo.slice(-9) : celularCrudo;
  const dni = primero(pedido, ["document", "dni", "documento", "document_number", "nro_documento"]).replace(/\D/g, "");
  const departamento = primero(pedido, ["department", "departamento"]);
  const provincia = primero(pedido, ["provincia", "province"]);
  const distrito = primero(pedido, ["distrito", "district", "city"]);
  const agencia = primero(pedido, ["shipping_agency", "agencia"]);
  const envioTipo = primero(pedido, ["shipping_type", "tipo_envio"]).toLowerCase();
  const esLima = /\b(LIMA|CALLAO)\b/i.test(`${departamento} ${provincia}`);

  const items: PedidoItem[] = [];
  const partes: string[] = [];
  for (const p of productosDe(pedido)) {
    const producto = productoDelCatalogo(p.nombre, catalogo);
    if (producto) {
      const ya = items.find((i) => i.producto === producto);
      if (ya) ya.cantidad += p.cantidad;
      else items.push({ producto, cantidad: p.cantidad });
    }
    partes.push(`${p.cantidad}x${producto ?? p.nombre}`);
  }

  const creado = primero(pedido, ["created_at", "fecha_creacion"]) || new Date().toISOString();
  const monto = numero(primero(pedido, ["total_amount", "total", "monto"]));
  const pagado = numero(primero(pedido, ["amount_paid", "pagado", "adelanto"]));
  const courier = primero(pedido, ["courier"]);

  return {
    cliente: primero(pedido, ["lead_full_name", "full_name", "customer_name", "nombre", "lead_name", "name"]) || "Cliente de WhatsApp",
    celular: celular || null,
    dni: dni.length >= 8 && dni.length <= 11 ? dni : null,
    direccion: primero(pedido, ["address", "direccion", "shipping_address", "address_line"]) || agencia || null,
    provincia: provincia || departamento || null,
    distrito: distrito || null,
    destino: departamento || provincia ? (esLima ? "Lima" : "Provincia") : null,
    monto: monto ?? 0,
    adelanto: pagado && pagado > 0 ? pagado : null,
    pedido: items.length ? resumenDeProductos(items) : partes.join(", "),
    items,
    courier: courier || null,
    envio: envioTipo === "agencia" ? "Prov.Agencia" : null,
    inventario: envioTipo === "agencia" ? "SOLUBRE" : null,
    canal: "WASAP IA",
    cerrado_por: "IA",
    estado: "CONFIRMADO",
    fecha_registro: dayKeyInZone(creado, "America/Lima"),
    nota: ["Venta de la IA (Flujos)", agencia && `Agencia: ${agencia}`, primero(pedido, ["notes", "nota", "observaciones"])]
      .filter(Boolean)
      .join(" · "),
    creado,
  };
}

/* ------------------------------------------------------------ analítica */

/** Lo que guarda `flujos_diario` de un día. */
export type DiaDeFlujos = {
  leads: number;
  leads_por_origen: Record<string, number>;
  leads_por_anuncio: Record<string, number>;
  ventas: number;
  ventas_ia: number;
  monto: number;
  ventas_por_etapa: Record<string, number>;
};

/** "2026-11-24" → el rango de ese día en Lima, para las consultas a Flujos. */
export function rangoDelDia(dia: string): { date_from: string; date_to: string } {
  return { date_from: `${dia}T00:00:00-05:00`, date_to: `${dia}T23:59:59-05:00` };
}

/**
 * Los leads de un día (de `leads_list`) y las métricas de pedidos de ese día
 * (de `orders_metrics`) → la fila de `flujos_diario`.
 */
export function resumirDiaDeFlujos(dia: string, leads: PedidoFlujos[], metricas: Record<string, unknown>): DiaDeFlujos {
  const leads_por_origen: Record<string, number> = {};
  const leads_por_anuncio: Record<string, number> = {};
  for (const lead of leads) {
    const anuncio = lead.anuncio && typeof lead.anuncio === "object" ? (lead.anuncio as Record<string, unknown>) : null;
    const origen = anuncio ? "Anuncio" : "Directo";
    leads_por_origen[origen] = (leads_por_origen[origen] ?? 0) + 1;
    if (anuncio) {
      const titulo = String(anuncio.headline ?? anuncio.ad_id ?? "Sin título").trim().slice(0, 80) || "Sin título";
      leads_por_anuncio[titulo] = (leads_por_anuncio[titulo] ?? 0) + 1;
    }
  }

  const porDia = Array.isArray(metricas.por_dia) ? (metricas.por_dia as Record<string, unknown>[]) : [];
  const delDia = porDia.find((d) => String(d.dia) === dia);
  const ventas_por_etapa: Record<string, number> = {};
  for (const etapa of Array.isArray(metricas.por_etapa) ? (metricas.por_etapa as Record<string, unknown>[]) : []) {
    ventas_por_etapa[String(etapa.etapa ?? "?")] = Number(etapa.pedidos ?? 0) || 0;
  }
  return {
    leads: leads.length,
    leads_por_origen,
    leads_por_anuncio,
    ventas: Number(delDia?.pedidos ?? metricas.pedidos ?? 0) || 0,
    ventas_ia: Number(metricas.creados_por_ia ?? 0) || 0,
    monto: Math.round((Number(delDia?.monto ?? metricas.monto_total ?? 0) || 0) * 100) / 100,
    ventas_por_etapa,
  };
}
