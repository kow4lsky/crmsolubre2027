import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Anota en el registro de las conexiones (Configuración → Conexiones) un
 * problema o un aviso de Swayp, Shalom, etc. Nunca hace fallar a quien lo
 * llama: si no se puede anotar (por ejemplo, falta correr el SQL), sigue.
 */
export async function anotarConexion(
  supabase: SupabaseClient,
  servicio: string,
  mensaje: string,
  { nivel = "error", datos = {}, workspaceId }: { nivel?: "info" | "aviso" | "error"; datos?: Record<string, unknown>; workspaceId?: string } = {},
) {
  try {
    let ws = workspaceId;
    if (!ws) {
      const { data } = await supabase.from("workspaces").select("id").order("created_at").limit(1).maybeSingle();
      ws = data?.id as string | undefined;
    }
    if (!ws) return;
    await supabase.from("conexion_registro").insert({ workspace_id: ws, servicio, nivel, mensaje: mensaje.slice(0, 1000), datos });
  } catch (error) {
    console.warn("[registro]", error instanceof Error ? error.message : error);
  }
}
