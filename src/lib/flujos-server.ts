import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { esDeIA, propuestaDesdeFlujos, rangoDelDia, resumirDiaDeFlujos, type PedidoFlujos } from "@/lib/flujos";
import { dayKeyInZone } from "@/lib/fechas";
import { credenciales } from "@/lib/integraciones-server";
import { llamarHerramientaMcp as llamarFlujos } from "@/lib/mcp-cliente";

/** Cada cuánto se le pregunta a Flujos, como mínimo: Flujos limita las consultas por día. */
const CADA_MS = 5 * 60 * 1000;
/** Margen hacia atrás en cada consulta, por si un pedido se guardó con unos segundos de atraso. */
const MARGEN_MS = 15 * 60 * 1000;
/** La primera vez se traen los últimos días. */
const PRIMERA_VEZ_MS = 3 * 24 * 60 * 60 * 1000;
const POR_PAGINA = 50;
const PAGINAS_MAXIMAS = 6;

export type ResultadoFlujos =
  | { ok: true; omitido?: string; revisados: number; deIA: number; nuevos: number }
  | { ok: false; error: string };

/**
 * Trae de Flujos las ventas nuevas de la IA y las deja en Pedidos pendientes.
 * Sin `forzar`, no vuelve a preguntar antes de 5 minutos de la última vez.
 */
export async function sincronizarFlujos(supabase: SupabaseClient, forzar = false): Promise<ResultadoFlujos> {
  const conexion = await credenciales("flujos", ["token", "url"]);
  if (!conexion.ok) return { ok: true, omitido: "sin conexión", revisados: 0, deIA: 0, nuevos: 0 };

  const ahora = Date.now();
  const { data: estado } = await supabase.from("sincronizaciones").select("ultima_at").eq("clave", "flujos").maybeSingle();
  const ultima = estado?.ultima_at ? new Date(estado.ultima_at as string).getTime() : null;
  if (!forzar && ultima && ahora - ultima < CADA_MS) {
    return { ok: true, omitido: "consultado hace poco", revisados: 0, deIA: 0, nuevos: 0 };
  }
  // Se marca antes de consultar: dos vueltas del reloj juntas no repiten el trabajo.
  await supabase.from("sincronizaciones").upsert({ clave: "flujos", ultima_at: new Date(ahora).toISOString(), updated_at: new Date().toISOString() });

  try {
    const { data: workspace } = await supabase.from("workspaces").select("id").order("created_at").limit(1).maybeSingle();
    if (!workspace) return { ok: false, error: "Todavía no hay workspace." };

    const desde = new Date((ultima ?? ahora - PRIMERA_VEZ_MS) - MARGEN_MS).toISOString();
    const pedidos: PedidoFlujos[] = [];
    for (let pagina = 0; pagina < PAGINAS_MAXIMAS; pagina++) {
      const respuesta = await llamarFlujos(conexion.valores.url, conexion.valores.token, "orders_list", {
        date_from: desde,
        limit: POR_PAGINA,
        offset: pagina * POR_PAGINA,
      });
      const items = (respuesta.items ?? []) as PedidoFlujos[];
      pedidos.push(...items);
      if (!respuesta.has_more || items.length < POR_PAGINA) break;
    }

    const deIA = pedidos.filter(esDeIA);
    const ids = deIA.map((p) => String(p.id ?? "")).filter(Boolean);
    const { data: yaEstan } = ids.length
      ? await supabase.from("pedidos_pendientes").select("externo_id").eq("workspace_id", workspace.id).eq("origen", "FLUJOS").in("externo_id", ids)
      : { data: [] };
    const conocidos = new Set((yaEstan ?? []).map((f) => f.externo_id as string));
    const nuevos = deIA.filter((p) => !conocidos.has(String(p.id)));

    if (nuevos.length) {
      const { data: productos } = await supabase.from("productos").select("nombre").eq("workspace_id", workspace.id);
      const catalogo = (productos ?? []).map((p) => p.nombre as string);
      const filas = [];
      for (const resumen of nuevos) {
        // El detalle trae lo que la lista resume (productos, dirección).
        let detalle: PedidoFlujos = resumen;
        try {
          detalle = { ...resumen, ...(await llamarFlujos(conexion.valores.url, conexion.valores.token, "orders_get", { order_id: resumen.id })) };
        } catch {
          // Sin detalle igual entra, con lo que trae la lista.
        }
        const propuesta = propuestaDesdeFlujos(detalle, catalogo);
        filas.push({
          workspace_id: workspace.id,
          origen: "FLUJOS",
          externo_id: String(resumen.id),
          cliente: propuesta.cliente,
          celular: propuesta.celular,
          monto: propuesta.monto,
          resumen: propuesta.pedido,
          propuesta,
          datos: detalle,
          creado_en_origen: propuesta.creado,
        });
      }
      const { error } = await supabase
        .from("pedidos_pendientes")
        .upsert(filas, { onConflict: "workspace_id,origen,externo_id", ignoreDuplicates: true });
      if (error) throw new Error(error.message);
    }

    await supabase.from("sincronizaciones").update({ ultimo_error: null }).eq("clave", "flujos");
    return { ok: true, revisados: pedidos.length, deIA: deIA.length, nuevos: nuevos.length };
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    console.error("[flujos]", mensaje);
    await supabase.from("sincronizaciones").update({ ultimo_error: mensaje.slice(0, 500) }).eq("clave", "flujos");
    return { ok: false, error: mensaje };
  }
}

/** Los números del día (leads y ventas de Flujos) se recalculan cada hora. */
const DIARIO_CADA_MS = 60 * 60 * 1000;
/** Tope de leads que se cuentan por día: 50 por página. */
const PAGINAS_DE_LEADS = 40;

/**
 * Guarda en `flujos_diario` cuántos leads entraron a Flujos hoy y ayer (de
 * qué anuncio) y cuántas ventas se cerraron ahí. Lo usa la Analítica.
 */
export async function actualizarFlujosDiario(supabase: SupabaseClient, forzar = false): Promise<ResultadoFlujos> {
  const conexion = await credenciales("flujos", ["token", "url"]);
  if (!conexion.ok) return { ok: true, omitido: "sin conexión", revisados: 0, deIA: 0, nuevos: 0 };

  const ahora = Date.now();
  const { data: estado } = await supabase.from("sincronizaciones").select("ultima_at").eq("clave", "flujos_diario").maybeSingle();
  const ultima = estado?.ultima_at ? new Date(estado.ultima_at as string).getTime() : null;
  if (!forzar && ultima && ahora - ultima < DIARIO_CADA_MS) {
    return { ok: true, omitido: "consultado hace poco", revisados: 0, deIA: 0, nuevos: 0 };
  }
  await supabase.from("sincronizaciones").upsert({ clave: "flujos_diario", ultima_at: new Date(ahora).toISOString(), updated_at: new Date().toISOString() });

  try {
    const { data: workspace } = await supabase.from("workspaces").select("id").order("created_at").limit(1).maybeSingle();
    if (!workspace) return { ok: false, error: "Todavía no hay workspace." };

    const hoy = dayKeyInZone(new Date(ahora), "America/Lima");
    const ayer = dayKeyInZone(new Date(ahora - 24 * 60 * 60 * 1000), "America/Lima");
    let revisados = 0;
    for (const dia of [ayer, hoy]) {
      const rango = rangoDelDia(dia);
      const leads: PedidoFlujos[] = [];
      for (let pagina = 0; pagina < PAGINAS_DE_LEADS; pagina++) {
        const respuesta = await llamarFlujos(conexion.valores.url, conexion.valores.token, "leads_list", {
          ...rango,
          limit: POR_PAGINA,
          offset: pagina * POR_PAGINA,
        });
        const items = (respuesta.items ?? []) as PedidoFlujos[];
        leads.push(...items);
        if (!respuesta.has_more || items.length < POR_PAGINA) break;
      }
      const metricas = await llamarFlujos(conexion.valores.url, conexion.valores.token, "orders_metrics", {
        ...rango,
        timezone: "America/Lima",
      });
      const fila = resumirDiaDeFlujos(dia, leads, metricas);
      const { error } = await supabase
        .from("flujos_diario")
        .upsert({ workspace_id: workspace.id, dia, ...fila, actualizado_at: new Date().toISOString() });
      if (error) throw new Error(error.message);
      revisados += leads.length;
    }
    await supabase.from("sincronizaciones").update({ ultimo_error: null }).eq("clave", "flujos_diario");
    return { ok: true, revisados, deIA: 0, nuevos: 0 };
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    console.error("[flujos diario]", mensaje);
    await supabase.from("sincronizaciones").update({ ultimo_error: mensaje.slice(0, 500) }).eq("clave", "flujos_diario");
    return { ok: false, error: mensaje };
  }
}
