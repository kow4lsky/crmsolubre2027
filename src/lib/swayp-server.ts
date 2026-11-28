import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { credenciales } from "@/lib/integraciones-server";
import { anotarConexion } from "@/lib/registro-conexiones";
import {
  cuerpoGuiaSwayp,
  medidasDe,
  problemasDeFilaSwayp,
  productosParaSwayp,
  type FilaSwayp,
  type RemitenteSwayp,
} from "@/lib/swayp-envios";

/**
 * Llamadas a la API de Swayp, sólo si están cargados token, URL base y correo
 * (son opcionales: los avisos de estado funcionan sin ellos).
 */
export async function consultarGuiaSwayp(guia: string): Promise<Record<string, unknown> | null> {
  const conexion = await credenciales("swayp", ["api_token", "base_url", "email"]);
  if (!conexion.ok) return null;
  const { api_token, base_url, email } = conexion.valores;
  const base = base_url.replace(/\/+$/, "");
  // Swayp opera en Colombia y Perú: x-country dice cuál (obligatorio en su API v2).
  const headers = { Authorization: `Bearer ${api_token}`, email, "x-country": "PE", "Content-Type": "application/json" };

  const pedir = () => fetch(`${base}/v2/guias/${encodeURIComponent(guia)}`, { headers, cache: "no-store" });
  try {
    let respuesta = await pedir();
    // Un token nuevo hay que activarlo una vez; Swayp responde 403 hasta entonces.
    if (respuesta.status === 403) {
      await fetch(`${base}/v1/integrations/activate`, { method: "POST", headers });
      respuesta = await pedir();
    }
    if (!respuesta.ok) {
      console.warn("[swayp] no se pudo consultar la guía", guia, respuesta.status);
      return null;
    }
    const cuerpo = (await respuesta.json()) as Record<string, unknown>;
    return (cuerpo.data as Record<string, unknown>) ?? cuerpo;
  } catch (error) {
    console.warn("[swayp] error al consultar la guía:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** Busca un valor por nombre de campo en cualquier nivel del detalle de la guía. */
export function buscarCampo(datos: unknown, nombres: string[]): unknown {
  const buscados = nombres.map((n) => n.toLowerCase());
  const pila: unknown[] = [datos];
  while (pila.length) {
    const actual = pila.pop();
    if (!actual || typeof actual !== "object") continue;
    for (const [clave, valor] of Object.entries(actual as Record<string, unknown>)) {
      if (buscados.includes(clave.toLowerCase()) && valor !== null && valor !== "" && typeof valor !== "object") return valor;
      if (valor && typeof valor === "object") pila.push(valor);
    }
  }
  return undefined;
}

export type ResultadoSwayp = {
  registrados: { codigo: string; guia: string }[];
  conError: { codigo: string; error: string }[];
};

/** El mensaje de error que devuelva Swayp, legible. */
function errorDeSwayp(status: number, cuerpo: unknown): string {
  const c = (cuerpo && typeof cuerpo === "object" ? cuerpo : {}) as Record<string, unknown>;
  const detalle = c.message ?? c.error ?? c.errors ?? c.msg;
  const texto = typeof detalle === "string" ? detalle : detalle ? JSON.stringify(detalle) : "";
  if (status === 401) return `Swayp no reconoce el correo o el token (401). ${texto}`.trim();
  if (status === 403) return `Swayp no da permiso (403): ¿el token está activo? ${texto}`.trim();
  return `Swayp respondió ${status}${texto ? `: ${texto}` : ""}`.slice(0, 400);
}

/**
 * "Registrar en Swayp": crea una guía por pedido con la API v2 y anota la guía
 * en el pedido. Lo que falle se informa pedido por pedido.
 */
export async function registrarEnSwayp(
  supabase: SupabaseClient,
  workspaceId: string,
  filas: FilaSwayp[],
): Promise<{ ok: true; resultado: ResultadoSwayp } | { ok: false; error: string }> {
  // Como en la carga masiva, los datos del remitente son opcionales: Swayp
  // completa lo que falte con los de la cuenta.
  const conexion = await credenciales("swayp", ["api_token", "base_url", "email"]);
  if (!conexion.ok) return { ok: false, error: conexion.error };
  const v = conexion.valores;
  const base = v.base_url.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${v.api_token}`, email: v.email, "x-country": "PE", "Content-Type": "application/json" };
  const remitente: RemitenteSwayp = {
    nombre: v.remitente_nombre || "SOLUBRE",
    nit: v.remitente_ruc ?? "",
    direccion: v.remitente_direccion ?? "",
    telefono: (v.remitente_telefono ?? "").replace(/\D/g, ""),
    email: v.remitente_email || v.email,
    ubigeo: (v.remitente_ubigeo ?? "").replace(/\D/g, ""),
    idBodega: Number(v.id_bodega) || null,
  };
  const paquete = medidasDe(v.paquete_medidas, v.paquete_peso);

  // Los pedidos, para no registrar dos veces y para mandar sus productos.
  const ids = filas.map((f) => f.pedidoId);
  const { data: pedidos } = await supabase
    .from("pedidos")
    .select("id, codigo, guia_swayp, inventario, estado")
    .eq("workspace_id", workspaceId)
    .in("id", ids);
  const { data: items } = await supabase.from("pedido_items").select("pedido_id, producto, cantidad").in("pedido_id", ids);
  const { data: productos } = await supabase.from("productos").select("nombre, codigo_swayp").eq("workspace_id", workspaceId);
  const codigos = new Map(
    (productos ?? []).filter((p) => p.codigo_swayp).map((p) => [String(p.nombre).toUpperCase(), String(p.codigo_swayp)]),
  );

  const resultado: ResultadoSwayp = { registrados: [], conError: [] };
  let activado = false;
  for (const fila of filas) {
    const pedido = (pedidos ?? []).find((p) => p.id === fila.pedidoId);
    if (!pedido) {
      resultado.conError.push({ codigo: fila.codigo, error: "No se encontró el pedido." });
      continue;
    }
    if (pedido.guia_swayp) {
      resultado.conError.push({ codigo: fila.codigo, error: `Ya tiene la guía ${pedido.guia_swayp}.` });
      continue;
    }
    const faltan = problemasDeFilaSwayp(fila);
    if (faltan.length) {
      resultado.conError.push({ codigo: fila.codigo, error: `Falta: ${faltan.join(", ")}.` });
      continue;
    }
    const deEste = (items ?? []).filter((i) => i.pedido_id === fila.pedidoId).map((i) => ({ producto: String(i.producto), cantidad: Number(i.cantidad) }));
    const lista = String(pedido.inventario ?? "").toUpperCase() === "SWAYP" ? productosParaSwayp(deEste, codigos) : null;
    const cuerpo = cuerpoGuiaSwayp(fila, remitente, paquete, lista ?? undefined);

    try {
      const enviar = () => fetch(`${base}/v2/guias`, { method: "POST", headers, body: JSON.stringify(cuerpo), cache: "no-store" });
      let respuesta = await enviar();
      // Un token nuevo hay que activarlo una vez.
      if (respuesta.status === 403 && !activado) {
        activado = true;
        await fetch(`${base}/v1/integrations/activate`, { method: "POST", headers });
        respuesta = await enviar();
      }
      const texto = await respuesta.text();
      let json: unknown = null;
      try {
        json = texto ? JSON.parse(texto) : null;
      } catch {
        json = { message: texto.slice(0, 200) };
      }
      const datos = ((json as { data?: unknown } | null)?.data ?? json) as Record<string, unknown> | null;
      const guia = datos?.guia ?? datos?.guide ?? datos?.numeroGuia;
      if (!respuesta.ok || !guia) {
        resultado.conError.push({ codigo: fila.codigo, error: errorDeSwayp(respuesta.status, json) });
        continue;
      }

      const estado = String(datos?.estado ?? "Generada");
      const { error } = await supabase
        .from("pedidos")
        .update({ guia_swayp: String(guia), estado_swayp: estado })
        .eq("id", fila.pedidoId);
      if (error) {
        resultado.conError.push({ codigo: fila.codigo, error: `Se creó la guía ${guia} en Swayp, pero no se pudo anotar: ${error.message}` });
        continue;
      }
      await supabase.from("envio_eventos").insert({
        workspace_id: workspaceId,
        pedido_id: fila.pedidoId,
        courier: "SWAYP",
        guia: String(guia),
        estado_codigo: String(datos?.idEstado ?? "1"),
        estado,
        comentario: `Guía creada desde el CRM (${fila.servicio === "EXPRESS" ? "express" : "programación normal"})${lista ? "" : " · sin códigos de producto"}`,
        entrega_id: `crm:${guia}`,
        recaudo: fila.recaudo,
        datos: { enviado: cuerpo, respuesta: json },
      });
      resultado.registrados.push({ codigo: fila.codigo, guia: String(guia) });
    } catch (error) {
      resultado.conError.push({ codigo: fila.codigo, error: `No se pudo conectar con Swayp: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  await anotarConexion(
    supabase,
    "SWAYP",
    `Registro de guías: ${resultado.registrados.length} creadas, ${resultado.conError.length} con error.`,
    { nivel: resultado.conError.length ? "aviso" : "info", datos: resultado, workspaceId },
  );
  return { ok: true, resultado };
}

/* ----------------------------------------------- estados 9 a. m. y 4 p. m. */

/** Las horas de Lima en que se consultan los estados de Swayp. */
const HORAS_SWAYP = [9, 16];
/** Cuántos días atrás se revisan las guías. */
const DIAS_SWAYP = 20;

/** El último horario de consulta que ya pasó (9:00 o 16:00 de Lima). */
function ultimoHorario(ahora: Date): number {
  const lima = new Date(ahora.getTime() - 5 * 60 * 60 * 1000); // Lima es UTC-5 todo el año.
  const dia = Date.UTC(lima.getUTCFullYear(), lima.getUTCMonth(), lima.getUTCDate());
  const hora = lima.getUTCHours();
  const pasadas = HORAS_SWAYP.filter((h) => h <= hora);
  const h = pasadas.length ? pasadas[pasadas.length - 1] : HORAS_SWAYP[HORAS_SWAYP.length - 1];
  const base = pasadas.length ? dia : dia - 24 * 60 * 60 * 1000;
  return base + (h + 5) * 60 * 60 * 1000; // de vuelta a UTC
}

export type ResultadoEstadosSwayp =
  | { ok: true; omitido?: string; guias: number; encontrados: number; actualizados: number }
  | { ok: false; error: string };

/**
 * A las 9 a. m. y a las 4 p. m. (o con "Actualizar Swayp"): trae de Swayp
 * todas las guías de los últimos días con su estado (POST /v2/guias/dates) y
 * las pasa a los pedidos de Lima. Empareja por guía, por el código del CRM
 * (columna id del Excel) o por celular.
 */
export async function actualizarEstadosSwayp(supabase: SupabaseClient, forzar = false): Promise<ResultadoEstadosSwayp> {
  const conexion = await credenciales("swayp", ["api_token", "base_url", "email"]);
  if (!conexion.ok) return { ok: true, omitido: "sin conexión", guias: 0, encontrados: 0, actualizados: 0 };

  const ahora = new Date();
  const { data: estado } = await supabase.from("sincronizaciones").select("ultima_at").eq("clave", "swayp_estados").maybeSingle();
  const ultima = estado?.ultima_at ? new Date(estado.ultima_at as string).getTime() : 0;
  if (!forzar && ultima >= ultimoHorario(ahora)) return { ok: true, omitido: "no es hora", guias: 0, encontrados: 0, actualizados: 0 };
  await supabase.from("sincronizaciones").upsert({ clave: "swayp_estados", ultima_at: ahora.toISOString(), updated_at: ahora.toISOString() });

  const v = conexion.valores;
  const base = v.base_url.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${v.api_token}`, email: v.email, "x-country": "PE", "Content-Type": "application/json" };
  try {
    const { leerGuiaSwayp, estadoDelCrm } = await import("@/lib/swayp");
    const { data: workspace } = await supabase.from("workspaces").select("id").order("created_at").limit(1).maybeSingle();
    if (!workspace) return { ok: false, error: "Todavía no hay workspace." };

    const fecha = (d: Date) => new Date(d.getTime() - 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
    // Swayp identifica al negocio por su RUC (id) o por el correo: se prueba
    // primero el RUC (si está cargado) y después el correo de la cuenta.
    const ruc = (v.remitente_ruc ?? "").replace(/\D/g, "");
    const identidades: Record<string, string>[] = [...(ruc ? [{ id: ruc }] : []), { email: v.email }];
    let identidad = identidades[0];
    const crudas: Record<string, unknown>[] = [];
    for (let pagina = 1; pagina <= 20; pagina++) {
      const pedir = (quien: Record<string, string>) =>
        fetch(`${base}/v2/guias/dates`, {
          method: "POST",
          headers,
          cache: "no-store",
          body: JSON.stringify({
            ...quien,
            fechaIni: fecha(new Date(ahora.getTime() - DIAS_SWAYP * 24 * 60 * 60 * 1000)),
            fechaFin: fecha(ahora),
            pagination: { pageSize: 200, page: pagina },
            fullData: true,
          }),
        });
      let respuesta = await pedir(identidad);
      if (respuesta.status === 403 && pagina === 1) {
        await fetch(`${base}/v1/integrations/activate`, { method: "POST", headers });
        for (const otra of identidades) {
          respuesta = await pedir(otra);
          identidad = otra;
          if (respuesta.status !== 403) break;
        }
      }
      const texto = await respuesta.text();
      if (respuesta.status === 403 && /no asociado/i.test(texto)) {
        throw new Error(
          `Swayp dice "Negocio no asociado a tu cuenta": el correo del token (${v.email}) no está vinculado a tu negocio en Swayp${ruc ? "" : " y falta el RUC en Conexiones → Swayp"}. Pídele a Swayp que lo asocie.`,
        );
      }
      if (!respuesta.ok) throw new Error(`Swayp respondió ${respuesta.status}: ${texto.slice(0, 200)}`);
      const json = texto ? (JSON.parse(texto) as unknown) : null;
      const items = listaDe(json);
      crudas.push(...items);
      if (items.length < 200 || !hayMasPaginas(json, pagina)) break;
    }
    const guias = crudas.map(leerGuiaSwayp).filter((g) => g.guia && g.codigo);

    // Los pedidos de Swayp de esos días que siguen abiertos (o sin guía).
    const desde = fecha(new Date(ahora.getTime() - (DIAS_SWAYP + 10) * 24 * 60 * 60 * 1000));
    const { data } = await supabase
      .from("pedidos")
      .select("id, codigo, celular, estado, guia_swayp, estado_swayp")
      .eq("workspace_id", workspace.id)
      .gte("fecha_registro", desde)
      .or("courier.ilike.%swayp%,inventario.eq.SWAYP")
      // Los más nuevos primero: por celular, la guía más nueva va al pedido más nuevo.
      .order("fecha_registro", { ascending: false })
      .limit(3000);
    type P = { id: string; codigo: string; celular: string | null; estado: string; guia_swayp: string | null; estado_swayp: string | null };
    const pedidos = (data ?? []) as P[];
    const porGuia = new Map(pedidos.filter((p) => p.guia_swayp).map((p) => [p.guia_swayp as string, p]));
    const porCodigo = new Map(pedidos.map((p) => [p.codigo.toUpperCase(), p]));
    const usados = new Set<string>();

    let encontrados = 0;
    let actualizados = 0;
    // De la más nueva a la más vieja: si un celular tiene varias guías, la última manda.
    for (const g of [...guias].sort((a, b) => Number(b.guia) - Number(a.guia))) {
      let pedido = porGuia.get(g.guia) ?? (g.idExterno ? porCodigo.get(g.idExterno) : undefined);
      if (!pedido && g.celular.length === 9) {
        pedido = pedidos.find((p) => !p.guia_swayp && !usados.has(p.id) && p.celular === g.celular);
      }
      if (!pedido || (usados.has(pedido.id) && pedido.guia_swayp !== g.guia)) continue;
      usados.add(pedido.id);
      encontrados += 1;

      const nuevo = estadoDelCrm(g.codigo, pedido.estado);
      const cambios: Record<string, unknown> = {};
      if (pedido.guia_swayp !== g.guia) cambios.guia_swayp = g.guia;
      if (pedido.estado_swayp !== g.estado) cambios.estado_swayp = g.estado;
      if (nuevo) cambios.estado = nuevo;
      if (nuevo === "EN TRÁNSITO") cambios.fecha_salida = ahora.toISOString();
      if (g.costo !== null) cambios.costo_envio = g.costo;
      if (!cambios.guia_swayp && !cambios.estado_swayp && !nuevo) continue;

      const { error } = await supabase.from("pedidos").update(cambios).eq("id", pedido.id);
      if (error) throw new Error(`${pedido.codigo}: ${error.message}`);
      if (cambios.estado_swayp) {
        await supabase.from("envio_eventos").insert({
          workspace_id: workspace.id,
          pedido_id: pedido.id,
          courier: "SWAYP",
          guia: g.guia,
          estado_codigo: g.codigo,
          estado: g.estado,
          comentario: nuevo ? `En el CRM: ${pedido.estado} → ${nuevo}` : null,
          entrega_id: `consulta:${g.guia}:${g.codigo}`,
          costo: g.costo,
          recaudo: g.recaudo,
          datos: {},
        });
      }
      // La devolución confirmada vuelve la mercadería al inventario.
      if (g.codigo === "12") await supabase.rpc("confirmar_retorno", { ws: workspace.id, pedido: pedido.id, nota: "Swayp confirmó la devolución en su bodega" });
      actualizados += 1;
    }

    await supabase.from("sincronizaciones").update({ ultimo_error: null }).eq("clave", "swayp_estados");
    await anotarConexion(
      supabase,
      "SWAYP",
      `Estados de Swayp: ${guias.length} guías de los últimos ${DIAS_SWAYP} días, ${encontrados} pedidos encontrados, ${actualizados} actualizados.`,
      { nivel: "info", workspaceId: workspace.id },
    );
    return { ok: true, guias: guias.length, encontrados, actualizados };
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    console.error("[swayp estados]", mensaje);
    await supabase.from("sincronizaciones").update({ ultimo_error: mensaje.slice(0, 500) }).eq("clave", "swayp_estados");
    await anotarConexion(supabase, "SWAYP", `No se pudieron traer los estados de Swayp: ${mensaje}`);
    return { ok: false, error: mensaje };
  }
}

/** La lista de guías, venga como venga ({ data: [...] }, { guias: [...] }, …). */
function listaDe(valor: unknown, profundidad = 0): Record<string, unknown>[] {
  if (Array.isArray(valor)) return valor as Record<string, unknown>[];
  if (!valor || typeof valor !== "object" || profundidad > 3) return [];
  const v = valor as Record<string, unknown>;
  for (const clave of ["data", "guias", "guides", "items", "rows", "results"]) {
    if (Array.isArray(v[clave])) return v[clave] as Record<string, unknown>[];
  }
  for (const clave of ["data", "result"]) {
    if (v[clave] && typeof v[clave] === "object") return listaDe(v[clave], profundidad + 1);
  }
  return [];
}

function hayMasPaginas(valor: unknown, pagina: number): boolean {
  const v = (valor && typeof valor === "object" ? valor : {}) as Record<string, unknown>;
  const p = (v.pagination ?? v.meta ?? (v.data as Record<string, unknown> | undefined)?.pagination ?? {}) as Record<string, unknown>;
  const total = Number(p.totalPages ?? p.total_pages ?? p.last_page ?? p.pages ?? 0);
  return total > pagina;
}
