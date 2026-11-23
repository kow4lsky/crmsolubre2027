import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { fechaYHoraDeLima } from "@/lib/pedidos";
import { sendPushToUsers } from "@/lib/push-notifications";

/**
 * Un aviso que se perdió por más de esto (el reloj estuvo parado, por ejemplo)
 * ya no se manda: llegar con horas de atraso confunde más de lo que ayuda. En
 * el CRM igual aparece en "Hora de llamar".
 */
const ATRASO_MAXIMO_MS = 6 * 60 * 60 * 1000;

type Llamada = {
  id: string;
  workspace_id: string;
  codigo: string;
  cliente: string;
  celular: string | null;
  prox_llamada_at: string;
  recordatorio_de: string;
};

/**
 * Las próximas llamadas que vencieron y todavía no se avisaron: notificación
 * push a quien las programó. Se marcan primero (`recordatorio_avisado_at`) para
 * que dos vueltas del reloj al mismo tiempo no avisen dos veces.
 */
export async function avisarLlamadas(
  supabase: SupabaseClient,
  ahora: Date = new Date(),
): Promise<{ avisadas: number; atrasadas: number }> {
  const { data, error } = await supabase
    .from("pedidos")
    .update({ recordatorio_avisado_at: ahora.toISOString() })
    .is("recordatorio_avisado_at", null)
    .eq("recordatorio_visto", false)
    .not("recordatorio_de", "is", null)
    .lte("prox_llamada_at", ahora.toISOString())
    .select("id, workspace_id, codigo, cliente, celular, prox_llamada_at, recordatorio_de");

  if (error) {
    // Sin el SQL de avisos todavía no existe la columna: no es una falla.
    if (!/recordatorio_avisado_at|prox_llamada_at/.test(error.message)) {
      console.error("[llamadas] no se pudieron reservar los avisos:", error.message);
    }
    return { avisadas: 0, atrasadas: 0 };
  }

  const filas = (data ?? []) as Llamada[];
  const aTiempo = filas.filter((fila) => ahora.getTime() - new Date(fila.prox_llamada_at).getTime() <= ATRASO_MAXIMO_MS);

  await Promise.all(
    aTiempo.map((fila) =>
      sendPushToUsers(supabase, {
        workspaceId: fila.workspace_id,
        userIds: [fila.recordatorio_de],
        aviso: {
          title: `Hora de llamar a ${fila.cliente}`.slice(0, 80),
          body: [fila.codigo, fila.celular, fechaYHoraDeLima(fila.prox_llamada_at)].filter(Boolean).join(" · "),
          // El pedido y no la persona: si se reprograma, el aviso nuevo pisa al viejo.
          tag: `llamada-${fila.id}`,
          url: `/?vista=pedidos&pedido=${encodeURIComponent(fila.codigo)}`,
        },
      }),
    ),
  );

  return { avisadas: aTiempo.length, atrasadas: filas.length - aTiempo.length };
}
