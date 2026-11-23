import "server-only";

import { credenciales } from "@/lib/integraciones-server";

/**
 * Llamadas a la API de Swayp, sólo si están cargados token, URL base y correo
 * (son opcionales: los avisos de estado funcionan sin ellos).
 */
export async function consultarGuiaSwayp(guia: string): Promise<Record<string, unknown> | null> {
  const conexion = await credenciales("swayp", ["api_token", "base_url", "email"]);
  if (!conexion.ok) return null;
  const { api_token, base_url, email } = conexion.valores;
  const base = base_url.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${api_token}`, email, "Content-Type": "application/json" };

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
