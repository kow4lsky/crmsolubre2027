import { NextResponse, type NextRequest } from "next/server";

import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { actualizarFlujosDiario, sincronizarFlujos, sincronizarLlamadas } from "@/lib/flujos-server";
import { actualizarEstadosShalom, mantenerSesionShalom } from "@/lib/shalom-server";
import { actualizarEstadosSwayp } from "@/lib/swayp-server";
import { avisarLlamadas } from "@/lib/llamadas-server";
import { avisarTareasVencidas } from "@/lib/tareas-server";
import { verifyZernioToken } from "@/lib/zernio";

// La clave de servicio exige runtime Node, no Edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * El reloj de los avisos de tareas vencidas.
 *
 * Vercel no tiene procesos vivos: alguien de afuera tiene que despertar a mirar
 * si hay tareas que vencieron. El endpoint no sabe quién lo llama —el cron de
 * Vercel, `pg_cron` de Supabase o un curl— y por eso se puede cambiar de reloj
 * sin tocar el código.
 *
 * Se autentica con `CRON_SECRET`, en el header `Authorization: Bearer` que manda
 * Vercel o en `?token=` para los que no pueden mandar headers. Corre con la
 * clave de servicio, así que sin secreto no contesta.
 */
async function correr(request: NextRequest) {
  // El recorte no es cosmético: un secreto pegado en el panel de Vercel se
  // lleva puesto el salto de línea del portapapeles, y la comparación es byte a
  // byte. Sin esto el síntoma es un 401 sin explicación, con los dos valores
  // viéndose idénticos en pantalla.
  const secreto = (process.env.CRON_SECRET ?? "").trim();
  if (!secreto) {
    return NextResponse.json({ error: "Falta la variable CRON_SECRET." }, { status: 500 });
  }

  const header = request.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
  const token = (bearer || request.nextUrl.searchParams.get("token") || "").trim();

  if (!verifyZernioToken(token, secreto)) {
    // Qué se dice y qué no: que el token llegó y si mide lo mismo alcanza para
    // separar "me equivoqué de valor" de "se coló un espacio", y no cuenta nada
    // que sirva para adivinarlo.
    return NextResponse.json(
      {
        error: "No autenticado.",
        tokenRecibido: token ? "sí" : "no llegó ningún token",
        largoIgual: token.length === secreto.length,
      },
      { status: 401 },
    );
  }

  const supabase = getSupabaseAdmin();

  // Las tareas vencidas y las próximas llamadas de los pedidos: el mismo reloj.
  // Tareas vencidas, próximas llamadas y ventas nuevas de la IA en Flujos: el mismo reloj.
  // Los leads del día para la Analítica, cada hora.
  // Y el estado de los envíos de Shalom, cada 12 horas (y su sesión, viva cada 20 minutos).
  // Y los leads del día para Llamadas, cada 5 minutos.
  // Y los estados de Swayp a las 9 a. m. y a las 4 p. m.
  const [tareas, llamadas, flujos, flujosDiario, shalom, shalomSesion, leadsDelDia, swayp] = await Promise.all([
    avisarTareasVencidas(supabase),
    avisarLlamadas(supabase),
    sincronizarFlujos(supabase),
    actualizarFlujosDiario(supabase),
    actualizarEstadosShalom(supabase),
    mantenerSesionShalom(supabase),
    sincronizarLlamadas(supabase),
    actualizarEstadosSwayp(supabase),
  ]);

  console.log("[cron] vuelta:", JSON.stringify({ tareas, llamadas, flujos, flujosDiario, shalom, shalomSesion, leadsDelDia, swayp }));

  return NextResponse.json({ ok: true, tareas, llamadas, flujos, flujosDiario, shalom });
}

// Vercel Cron entra por GET; un `pg_cron` con `pg_net` suele mandar POST.
export const GET = correr;
export const POST = correr;
