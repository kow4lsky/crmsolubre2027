import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { dayKeyInZone } from "@/lib/fechas";
import { credenciales } from "@/lib/integraciones-server";
import { anotarConexion } from "@/lib/registro-conexiones";
import type { Estado } from "@/lib/pedidos";
import {
  cookieDeSesion,
  emparejarPorDni,
  estadoCrmDesdeShalom,
  etiquetaShalom,
  leerEnvioShalom,
  ordenDelTracking,
  trackingShalom,
  type EnvioShalom,
} from "@/lib/shalom-envios";
import { ClienteShalomPro, SesionVencida, historial, pendientes, rastreo, registrarMasivo } from "@/lib/shalom-pro";

const ZONA = "America/Lima";
/** Los estados de Shalom se consultan cada 12 horas. */
const CADA_MS = 12 * 60 * 60 * 1000;
/**
 * La sesión de Shalom PRO se cierra sola si nadie la usa por un rato (unas
 * horas). El CRM entra cada 20 minutos para que siga abierta.
 */
const MANTENER_CADA_MS = 20 * 60 * 1000;
/** Hasta cuántos días atrás se siguen los envíos que todavía no llegan. */
const DIAS_DE_SEGUIMIENTO = 45;

type PedidoShalom = {
  id: string;
  workspace_id: string;
  codigo: string;
  dni: string | null;
  estado: Estado;
  tracking: string | null;
  estado_shalom: string | null;
};
const COLUMNAS = "id, workspace_id, codigo, dni, estado, tracking, estado_shalom";

async function cliente(): Promise<{ ok: true; cliente: ClienteShalomPro; clave: string } | { ok: false; error: string }> {
  const conexion = await credenciales("shalom", ["sesion"]);
  if (!conexion.ok) return { ok: false, error: conexion.error };
  const cookie = cookieDeSesion(conexion.valores.sesion);
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

  // Cada estado nuevo de Shalom queda en el historial de envíos del pedido.
  const etiqueta = etiquetaShalom(envio.estado);
  if (etiqueta !== pedido.estado_shalom) {
    const { error: errorEvento } = await supabase.from("envio_eventos").insert({
      workspace_id: pedido.workspace_id,
      pedido_id: pedido.id,
      courier: "SHALOM",
      guia: trackingShalom(envio),
      estado_codigo: envio.estado,
      estado: etiqueta,
      comentario: [envio.destino && `Destino: ${envio.destino}`, nuevo && `En el CRM: ${pedido.estado} → ${nuevo}`].filter(Boolean).join(" · ") || null,
      // Un mismo estado de una misma orden no se anota dos veces.
      entrega_id: `${envio.orden}:${envio.estado}`,
      costo: envio.costo,
      datos: envio,
    });
    if (errorEvento && errorEvento.code !== "23505") console.warn("[shalom] no se pudo anotar el evento:", errorEvento.message);
  }
  return nuevo;
}

/** El nombre o correo de la cuenta, de lo que devuelva /auth/me. */
function cuentaDe(yo: unknown): string {
  const v = (yo && typeof yo === "object" ? yo : {}) as Record<string, unknown>;
  const usuario = (v.user && typeof v.user === "object" ? v.user : v) as Record<string, unknown>;
  return String(usuario.name ?? usuario.nombre ?? usuario.razon_social ?? usuario.email ?? "").trim();
}

/**
 * Entra a Shalom PRO para que la sesión no se cierre por falta de uso (cada
 * 20 minutos, desde el cron) y, de paso, confirma que sigue abierta.
 */
export async function mantenerSesionShalom(
  supabase: SupabaseClient,
  forzar = false,
): Promise<{ ok: true; omitido?: string; cuenta?: string } | { ok: false; error: string }> {
  const conexion = await cliente();
  if (!conexion.ok) return { ok: true, omitido: "sin conexión" };

  const ahora = Date.now();
  const { data: estado } = await supabase.from("sincronizaciones").select("ultima_at, ultimo_error").eq("clave", "shalom_sesion").maybeSingle();
  const ultima = estado?.ultima_at ? new Date(estado.ultima_at as string).getTime() : null;
  if (!forzar && ultima && ahora - ultima < MANTENER_CADA_MS) return { ok: true, omitido: "hace poco" };
  await supabase
    .from("sincronizaciones")
    .upsert({ clave: "shalom_sesion", ultima_at: new Date(ahora).toISOString(), updated_at: new Date().toISOString() });

  try {
    const cuenta = cuentaDe(await conexion.cliente.abrir());
    await supabase.from("sincronizaciones").update({ ultimo_error: null }).eq("clave", "shalom_sesion");
    if (estado?.ultimo_error) await anotarConexion(supabase, "SHALOM", `Sesión de Shalom PRO abierta de nuevo${cuenta ? ` (${cuenta})` : ""}.`, { nivel: "info" });
    return { ok: true, cuenta };
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    console.error("[shalom sesión]", mensaje);
    await supabase.from("sincronizaciones").update({ ultimo_error: mensaje.slice(0, 500) }).eq("clave", "shalom_sesion");
    // Se anota una vez, no cada 20 minutos mientras siga igual.
    if (estado?.ultimo_error !== mensaje.slice(0, 500)) await anotarConexion(supabase, "SHALOM", mensaje);
    return { ok: false, error: error instanceof SesionVencida ? mensaje : `No se pudo entrar a Shalom PRO: ${mensaje}` };
  }
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
      .select(COLUMNAS)
      .eq("workspace_id", workspaceId)
      .in("id", pedidoIds);
    const pedidos = (data ?? []) as PedidoShalom[];

    // Lo recién enviado aparece en "envíos pendientes" y en el historial de hoy.
    const hoy = dayKeyInZone(new Date(), ZONA);
    const envios = [
      ...(await pendientes(conexion.cliente)),
      ...(await rastreo(conexion.cliente, 2)),
      ...(await historial(conexion.cliente, hace(1), hoy, 5)),
    ].map(leerEnvioShalom);
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
    await anotarConexion(
      supabase,
      "SHALOM",
      `Registro masivo: ${registrados.length} con tracking, ${sinTracking.length} sin tracking todavía, ${conError.length} rechazados por Shalom.`,
      { nivel: conError.length || sinTracking.length ? "aviso" : "info", datos: { registrados, sinTracking, conError }, workspaceId },
    );
    return { ok: true, resultado: { registrados, sinTracking, conError, mensaje: registro.mensaje } };
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    await anotarConexion(supabase, "SHALOM", `No se pudo registrar en Shalom: ${mensaje}`, { workspaceId });
    return { ok: false, error: mensaje };
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
): Promise<{ ok: true; omitido?: string; revisados: number; actualizados: number; resumen?: string } | { ok: false; error: string }> {
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
      .select(COLUMNAS)
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
    // El estado sólo viene en "Rastreo" (el historial no lo trae).
    let crudos = await rastreo(conexion.cliente);
    // Si sin fechas no trae nada, se prueba con el rango de seguimiento.
    if (!crudos.length) crudos = await rastreo(conexion.cliente, 60, { from_date: desde, to_date: dayKeyInZone(new Date(), ZONA) });
    const forma = crudos.forma;
    const envios = crudos.map(leerEnvioShalom);
    const porOrden = new Map(envios.filter((e) => e.orden).map((e) => [e.orden, e]));

    // Primero por N° de orden (el tracking); si no aparece, por DNI.
    const porDni = emparejarPorDni(pedidos, envios);

    let actualizados = 0;
    let emparejados = 0;
    for (const pedido of pedidos) {
      const ordenGuardada = ordenDelTracking(pedido.tracking);
      const envio = (ordenGuardada ? porOrden.get(ordenGuardada) : undefined) ?? porDni.get(pedido.id);
      if (!envio) continue;
      emparejados += 1;
      const orden = ordenGuardada && porOrden.has(ordenGuardada) ? ordenGuardada : null;
      const cambiaEstado = estadoCrmDesdeShalom(envio.estado, pedido.estado);
      if (!cambiaEstado && pedido.estado_shalom === etiquetaShalom(envio.estado) && orden) continue;
      await anotar(supabase, pedido, envio, orden ? null : conexion.clave);
      actualizados += 1;
    }
    await supabase.from("sincronizaciones").update({ ultimo_error: null }).eq("clave", "shalom");
    // Un resumen para entender qué devolvió Shalom (sin datos de clientes).
    const porEstado = new Map<string, number>();
    for (const e of envios) porEstado.set(etiquetaShalom(e.estado), (porEstado.get(etiquetaShalom(e.estado)) ?? 0) + 1);
    const resumen =
      `Shalom tiene ${envios.length} envío(s) en Rastreo` +
      (porEstado.size ? ` (${[...porEstado].map(([estado, n]) => `${estado.toLowerCase()}: ${n}`).join(", ")})` : "") +
      `; ${emparejados} de ${pedidos.length} pedidos del CRM se encontraron ahí.` +
      (envios.length ? "" : ` Respuesta de Shalom: ${forma.slice(0, 300)}`);
    await anotarConexion(supabase, "SHALOM", `Estados de Shalom: ${actualizados} cambiaron. ${resumen}`, {
      nivel: emparejados < pedidos.length ? "aviso" : "info",
      workspaceId: workspace.id,
    });
    return { ok: true, revisados: pedidos.length, actualizados, resumen };
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    console.error("[shalom]", mensaje);
    await supabase.from("sincronizaciones").update({ ultimo_error: mensaje.slice(0, 500) }).eq("clave", "shalom");
    await anotarConexion(supabase, "SHALOM", `No se pudieron traer los estados: ${mensaje}`);
    return { ok: false, error: error instanceof SesionVencida ? error.message : `No se pudo consultar Shalom PRO: ${mensaje}` };
  }
}
