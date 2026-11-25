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
  const conexion = await credenciales("swayp", [
    "api_token",
    "base_url",
    "email",
    "remitente_ruc",
    "remitente_direccion",
    "remitente_telefono",
    "remitente_email",
    "remitente_ubigeo",
  ]);
  if (!conexion.ok) return { ok: false, error: conexion.error };
  const v = conexion.valores;
  const base = v.base_url.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${v.api_token}`, email: v.email, "x-country": "PE", "Content-Type": "application/json" };
  const remitente: RemitenteSwayp = {
    nombre: v.remitente_nombre || "SOLUBRE",
    nit: v.remitente_ruc,
    direccion: v.remitente_direccion,
    telefono: v.remitente_telefono.replace(/\D/g, ""),
    email: v.remitente_email,
    ubigeo: v.remitente_ubigeo.replace(/\D/g, ""),
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
