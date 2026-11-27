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
      // Los leads se cuentan con lo que ya trajo Llamadas: pedirlos otra vez a
      // Flujos gasta su límite diario de consultas.
      const { data: deLlamadas } = await supabase
        .from("llamadas")
        .select("anuncio")
        .eq("workspace_id", workspace.id)
        .eq("dia", dia)
        .limit(5000);
      const leads: PedidoFlujos[] = (deLlamadas ?? []).map((l) => ({ anuncio: l.anuncio ? { headline: l.anuncio } : null }));
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

/** Los leads del día para Llamadas se traen cada 5 minutos. */
const LLAMADAS_CADA_MS = 5 * 60 * 1000;

/**
 * Trae de Flujos los leads que entraron hoy (hora de Lima) y los deja en la
 * tabla de Llamadas. Actualiza nombre, celular, producto, etapa y etiquetas;
 * lo que marcó la asesora (la llamada, el pedido enlazado) no se toca.
 */
export async function sincronizarLlamadas(supabase: SupabaseClient, forzar = false, diaPedido?: string): Promise<ResultadoFlujos> {
  const conexion = await credenciales("flujos", ["token", "url"]);
  if (!conexion.ok) return { ok: true, omitido: "sin conexión", revisados: 0, deIA: 0, nuevos: 0 };

  const ahora = Date.now();
  // "llamadas": la última vez que se trajo bien. "llamadas_espera": hasta
  // cuándo no se intenta (después de llegar al límite diario de Flujos).
  const { data: estados } = await supabase.from("sincronizaciones").select("clave, ultima_at").in("clave", ["llamadas", "llamadas_espera"]);
  const marca = (clave: string) => {
    const valor = estados?.find((e) => e.clave === clave)?.ultima_at;
    return valor ? new Date(valor as string).getTime() : null;
  };
  const ultima = marca("llamadas");
  const espera = marca("llamadas_espera");
  if (!forzar && espera && ahora < espera) return { ok: true, omitido: "límite de Flujos", revisados: 0, deIA: 0, nuevos: 0 };
  if (!forzar && ultima && ahora - ultima < LLAMADAS_CADA_MS) {
    return { ok: true, omitido: "consultado hace poco", revisados: 0, deIA: 0, nuevos: 0 };
  }

  try {
    const { data: workspace } = await supabase.from("workspaces").select("id").order("created_at").limit(1).maybeSingle();
    if (!workspace) return { ok: false, error: "Todavía no hay workspace." };

    const { leadDeLlamada } = await import("@/lib/llamadas");
    const hoy = dayKeyInZone(new Date(ahora), "America/Lima");
    // Un día pedido a mano se trae entero. El reloj sólo trae lo nuevo desde
    // la última vez (con margen): Flujos limita los registros por día.
    const dia = diaPedido ?? hoy;
    const rango = rangoDelDia(dia);
    if (!diaPedido && ultima && dayKeyInZone(new Date(ultima), "America/Lima") === hoy) {
      rango.date_from = new Date(ultima - MARGEN_MS).toISOString();
    }

    // Los nombres de las etiquetas (los leads traen el id).
    const etiquetas = new Map<string, string>();
    try {
      const r = await llamarFlujos(conexion.valores.url, conexion.valores.token, "lead_labels_list", {});
      for (const e of (r.etiquetas ?? r.labels ?? r.items ?? []) as Record<string, unknown>[]) etiquetas.set(String(e.id), String(e.name ?? ""));
    } catch {
      // Sin nombres: se muestra el id.
    }
    const { data: productos } = await supabase.from("productos").select("nombre").eq("workspace_id", workspace.id);
    const catalogo = (productos ?? []).map((p) => p.nombre as string);

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

    const filas = leads
      .map((lead) => leadDeLlamada(lead, etiquetas, catalogo))
      .filter((f): f is NonNullable<typeof f> => f !== null)
      .map((f) => ({ ...f, workspace_id: workspace.id, dia: dayKeyInZone(new Date(f.creado_en), "America/Lima"), actualizado_at: new Date().toISOString() }));
    for (let i = 0; i < filas.length; i += 200) {
      const { error } = await supabase.from("llamadas").upsert(filas.slice(i, i + 200), { onConflict: "workspace_id,lead_id" });
      if (error) throw new Error(error.message);
    }
    // Sólo con éxito se mueve la marca (y no al traer a mano un día pasado):
    // así la próxima vuelta no se salta leads.
    if (!diaPedido || diaPedido === hoy) {
      await supabase
        .from("sincronizaciones")
        .upsert({ clave: "llamadas", ultima_at: new Date(ahora).toISOString(), ultimo_error: null, updated_at: new Date().toISOString() });
    }
    return { ok: true, revisados: leads.length, deIA: 0, nuevos: filas.length };
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    console.error("[llamadas]", mensaje);
    const limite = /\b429\b|l[ií]mite diario/i.test(mensaje);
    // Con el límite diario alcanzado, no se vuelve a intentar en una hora.
    await supabase.from("sincronizaciones").upsert({ clave: "llamadas", ultima_at: ultima ? new Date(ultima).toISOString() : null, ultimo_error: mensaje.slice(0, 500), updated_at: new Date().toISOString() });
    if (limite) {
      await supabase
        .from("sincronizaciones")
        .upsert({ clave: "llamadas_espera", ultima_at: new Date(ahora + 60 * 60 * 1000).toISOString(), updated_at: new Date().toISOString() });
    }
    return {
      ok: false,
      error: limite
        ? "Flujos llegó a su límite diario de consultas. Lo que ya se trajo sigue aquí; se vuelve a intentar solo en una hora."
        : mensaje,
    };
  }
}
