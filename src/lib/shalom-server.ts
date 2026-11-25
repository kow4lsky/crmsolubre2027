import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { dayKeyInZone } from "@/lib/fechas";
import { credenciales } from "@/lib/integraciones-server";
import type { Estado } from "@/lib/pedidos";
import {
  cookieRecuerdame,
  emparejarPorDni,
  estadoCrmDesdeShalom,
  etiquetaShalom,
  leerEnvioShalom,
  ordenDelTracking,
  trackingShalom,
  type EnvioShalom,
} from "@/lib/shalom-envios";
import { ClienteShalomPro, SesionVencida, historial, pendientes, registrarMasivo } from "@/lib/shalom-pro";

const ZONA = "America/Lima";
/** Los estados de Shalom se consultan cada 12 horas. */
const CADA_MS = 12 * 60 * 60 * 1000;
/** Hasta cuántos días atrás se siguen los envíos que todavía no llegan. */
const DIAS_DE_SEGUIMIENTO = 45;

type PedidoShalom = { id: string; codigo: string; dni: string | null; estado: Estado; tracking: string | null; estado_shalom: string | null };

async function cliente(): Promise<{ ok: true; cliente: ClienteShalomPro; clave: string } | { ok: false; error: string }> {
  const conexion = await credenciales("shalom", ["sesion"]);
  if (!conexion.ok) return { ok: false, error: conexion.error };
  const cookie = cookieRecuerdame(conexion.valores.sesion);
  if (!cookie) return { ok: false, error: "La cookie de Shalom PRO no se entiende. Vuelve a copiarla en Configuración → Conexiones → Shalom PRO." };
  return { ok: true, cliente: new ClienteShalomPro(cookie), clave: conexion.valores.clave || "1126" };
}

function hace(dias: number, desde = new Date()) {
  return dayKeyInZone(new Date(desde.getTime() - dias * 24 * 60 * 60 * 1000), ZONA);
}

/** Escribe en el pedido lo que dice Shalom: tracking, clave, costo, estado del courier y, si avanzó, el estado. */
async function anotar(supabase: SupabaseClient, pedido: PedidoShalom, envio: EnvioShalom, clave: string | null) {
  const cambios: Record<string, unknown> = { estado_shalom: etiquetaShalom(envio.estado) };
  if (!ordenDelTracking(pedido.tracking)) cambios.tracking = trackingShalom(envio);
  if (clave) cambios.clave = clave;
  if (envio.costo !== null) cambios.costo_envio = envio.costo;
  const nuevo = estadoCrmDesdeShalom(envio.estado, pedido.estado);
  if (nuevo) cambios.estado = nuevo;
  const { error } = await supabase.from("pedidos").update(cambios).eq("id", pedido.id);
  if (error) throw new Error(error.message);
  return nuevo;
}

export type ResultadoShalom = {
  registrados: { codigo: string; tracking: string; costo: number | null }[];
  sinTracking: string[];
  conError: string[];
  mensaje: string;
};

/**
 * "Registrar en Shalom": sube el Excel ya armado, pone la clave, envía, y
 * anota en cada pedido el tracking, la clave y el costo que devolvió Shalom.
 */
export async function registrarEnShalom(
  supabase: SupabaseClient,
  workspaceId: string,
  archivo: Uint8Array,
  pedidoIds: string[],
): Promise<{ ok: true; resultado: ResultadoShalom } | { ok: false; error: string }> {
  const conexion = await cliente();
  if (!conexion.ok) return conexion;
  try {
    await conexion.cliente.abrir();
    const registro = await registrarMasivo(conexion.cliente, archivo, conexion.clave);

    const { data } = await supabase
      .from("pedidos")
      .select("id, codigo, dni, estado, tracking, estado_shalom")
      .eq("workspace_id", workspaceId)
      .in("id", pedidoIds);
    const pedidos = (data ?? []) as PedidoShalom[];

    // Lo recién enviado aparece en "envíos pendientes" y en el historial de hoy.
    const hoy = dayKeyInZone(new Date(), ZONA);
    const envios = [...(await pendientes(conexion.cliente)), ...(await historial(conexion.cliente, hace(1), hoy, 5))].map(leerEnvioShalom);
    const pares = emparejarPorDni(pedidos, envios);

    const registrados: ResultadoShalom["registrados"] = [];
    for (const pedido of pedidos) {
      const envio = pares.get(pedido.id);
      if (!envio) continue;
      await anotar(supabase, pedido, envio, conexion.clave);
      registrados.push({ codigo: pedido.codigo, tracking: trackingShalom(envio), costo: envio.costo });
    }
    const sinTracking = pedidos.filter((p) => !pares.has(p.id)).map((p) => p.codigo);
    const conError = registro.conError.map((b) => `${String(b.document_number ?? b.doc_consignatario ?? b.id)}: ${String(b.error)}`);
    return { ok: true, resultado: { registrados, sinTracking, conError, mensaje: registro.mensaje } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Cada 12 horas: trae de Shalom el estado de los envíos de los últimos días y
 * lo pasa a los pedidos (y, de paso, completa el tracking de los que se
 * registraron a mano en Shalom, por DNI).
 */
export async function actualizarEstadosShalom(
  supabase: SupabaseClient,
  forzar = false,
): Promise<{ ok: true; omitido?: string; revisados: number; actualizados: number } | { ok: false; error: string }> {
  const conexion = await cliente();
  if (!conexion.ok) return { ok: true, omitido: "sin conexión", revisados: 0, actualizados: 0 };

  const ahora = Date.now();
  const { data: estado } = await supabase.from("sincronizaciones").select("ultima_at").eq("clave", "shalom").maybeSingle();
  const ultima = estado?.ultima_at ? new Date(estado.ultima_at as string).getTime() : null;
  if (!forzar && ultima && ahora - ultima < CADA_MS) return { ok: true, omitido: "consultado hace poco", revisados: 0, actualizados: 0 };
  await supabase.from("sincronizaciones").upsert({ clave: "shalom", ultima_at: new Date(ahora).toISOString(), updated_at: new Date().toISOString() });

  try {
    const { data: workspace } = await supabase.from("workspaces").select("id").order("created_at").limit(1).maybeSingle();
    if (!workspace) return { ok: false, error: "Todavía no hay workspace." };

    const desde = hace(DIAS_DE_SEGUIMIENTO);
    const { data } = await supabase
      .from("pedidos")
      .select("id, codigo, dni, estado, tracking, estado_shalom")
      .eq("workspace_id", workspace.id)
      .ilike("courier", "%shalom%")
      .in("estado", ["CONFIRMADO", "EN TRÁNSITO", "EN OFICINA"])
      .gte("fecha_registro", desde)
      .limit(2000);
    const pedidos = (data ?? []) as PedidoShalom[];
    if (pedidos.length === 0) {
      await supabase.from("sincronizaciones").update({ ultimo_error: null }).eq("clave", "shalom");
      return { ok: true, revisados: 0, actualizados: 0 };
    }

    await conexion.cliente.abrir();
    const envios = (await historial(conexion.cliente, desde, dayKeyInZone(new Date(), ZONA))).map(leerEnvioShalom);
    const porOrden = new Map(envios.filter((e) => e.orden).map((e) => [e.orden, e]));

    // Primero por N° de orden (el tracking); los que no tienen, por DNI.
    const sinOrden = pedidos.filter((p) => !ordenDelTracking(p.tracking));
    const porDni = emparejarPorDni(sinOrden, envios);

    let actualizados = 0;
    for (const pedido of pedidos) {
      const orden = ordenDelTracking(pedido.tracking);
      const envio = orden ? porOrden.get(orden) : porDni.get(pedido.id);
      if (!envio) continue;
      const cambiaEstado = estadoCrmDesdeShalom(envio.estado, pedido.estado);
      if (!cambiaEstado && pedido.estado_shalom === etiquetaShalom(envio.estado) && orden) continue;
      await anotar(supabase, pedido, envio, orden ? null : conexion.clave);
      actualizados += 1;
    }
    await supabase.from("sincronizaciones").update({ ultimo_error: null }).eq("clave", "shalom");
    return { ok: true, revisados: pedidos.length, actualizados };
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    console.error("[shalom]", mensaje);
    await supabase.from("sincronizaciones").update({ ultimo_error: mensaje.slice(0, 500) }).eq("clave", "shalom");
    return { ok: false, error: error instanceof SesionVencida ? error.message : `No se pudo consultar Shalom PRO: ${mensaje}` };
  }
}
