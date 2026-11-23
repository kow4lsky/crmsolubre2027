import { NextResponse, type NextRequest } from "next/server";

import { credenciales, estaConfigurada } from "@/lib/integraciones-server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { estadoDelCrm, leerAvisoSwayp, verificarFirmaSwayp, type AvisoSwayp } from "@/lib/swayp";
import { buscarCampo, consultarGuiaSwayp } from "@/lib/swayp-server";

// node:crypto y la service-role key exigen runtime Node, no Edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const numero = (valor: unknown) => {
  const n = Number(String(valor ?? "").replace(/[^\d.-]/g, ""));
  return valor === undefined || valor === null || valor === "" || !Number.isFinite(n) ? null : n;
};

/**
 * Swayp avisa acá cada cambio de estado de una guía.
 *
 * Responde siempre 2xx salvo firma inválida (401, que Swayp no reintenta) o un
 * error nuestro (500, que sí reintenta). Un aviso repetido (mismo
 * x-swayp-delivery) se ignora.
 */
export async function POST(request: NextRequest) {
  const conexion = await credenciales("swayp", ["webhook_secret"]);
  if (!conexion.ok) {
    console.error("[swayp]", conexion.error);
    return NextResponse.json({ error: conexion.error }, { status: 500 });
  }

  const cuerpo = await request.text();
  if (!verificarFirmaSwayp(cuerpo, request.headers.get("x-swayp-signature"), conexion.valores.webhook_secret)) {
    console.warn("[swayp] firma inválida");
    return NextResponse.json({ error: "Firma inválida: revisa el secreto en Configuración → Conexiones." }, { status: 401 });
  }

  let aviso: ReturnType<typeof leerAvisoSwayp>;
  try {
    aviso = leerAvisoSwayp(JSON.parse(cuerpo) as AvisoSwayp);
  } catch {
    return NextResponse.json({ ok: true, ignorado: "el cuerpo no es JSON" });
  }
  if (!aviso) return NextResponse.json({ ok: true, ignorado: "sin guía o sin estado" });

  const admin = getSupabaseAdmin();
  const { data: workspace } = await admin
    .from("workspaces")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!workspace) return NextResponse.json({ error: "Todavía no hay workspace." }, { status: 500 });

  // El pedido de la guía.
  type Fila = { id: string; codigo: string; estado: string; guia_swayp: string | null };
  const { data: porGuia } = await admin
    .from("pedidos")
    .select("id, codigo, estado, guia_swayp")
    .eq("workspace_id", workspace.id)
    .eq("guia_swayp", aviso.guia)
    .limit(1)
    .maybeSingle<Fila>();
  let pedido: Fila | null = porGuia ?? null;

  // El detalle de la guía, si está la API cargada: trae costo, recaudo y el
  // teléfono para ubicar las guías que el CRM todavía no conoce.
  const detalle = await consultarGuiaSwayp(aviso.guia);

  if (!pedido && detalle) {
    const telefono = String(buscarCampo(detalle, ["telefonoDestinatario", "telefono_destinatario", "telefono"]) ?? "").replace(/\D/g, "");
    const celular = telefono.length > 9 ? telefono.slice(-9) : telefono;
    if (celular.length === 9) {
      const desde = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const { data: candidatos } = await admin
        .from("pedidos")
        .select("id, codigo, estado, guia_swayp")
        .eq("workspace_id", workspace.id)
        .eq("celular", celular)
        .is("guia_swayp", null)
        .gte("fecha_registro", desde)
        .order("fecha_registro", { ascending: false })
        .limit(1)
        .returns<Fila[]>();
      pedido = candidatos?.[0] ?? null;
    }
  }

  // El aviso al historial. Si ya estaba (Swayp lo reintentó), no se repite nada.
  const entrega = request.headers.get("x-swayp-delivery");
  const { error: errorEvento } = await admin.from("envio_eventos").insert({
    workspace_id: workspace.id,
    pedido_id: pedido?.id ?? null,
    courier: "SWAYP",
    guia: aviso.guia,
    estado_codigo: aviso.codigo,
    estado: aviso.estado,
    comentario: aviso.comentario || null,
    entrega_id: entrega,
    costo: numero(buscarCampo(detalle, ["valorFlete", "flete", "costoEnvio"])),
    recaudo: numero(buscarCampo(detalle, ["valorRecaudo", "recaudo"])),
    datos: detalle ?? {},
  });
  if (errorEvento?.code === "23505") return NextResponse.json({ ok: true, repetido: true });
  if (errorEvento) {
    console.error("[swayp] no se pudo guardar el aviso:", errorEvento.message);
    return NextResponse.json({ error: errorEvento.message }, { status: 500 });
  }

  if (!pedido) return NextResponse.json({ ok: true, sinPedido: aviso.guia });

  const cambios: Record<string, unknown> = { estado_swayp: aviso.estado };
  if (!pedido.guia_swayp) cambios.guia_swayp = aviso.guia;
  const nuevo = estadoDelCrm(aviso.codigo, pedido.estado);
  if (nuevo) cambios.estado = nuevo;
  if (nuevo === "EN TRÁNSITO") cambios.fecha_salida = new Date().toISOString();
  const costo = numero(buscarCampo(detalle, ["valorFlete", "flete", "costoEnvio"]));
  if (costo !== null) cambios.costo_envio = costo;

  const { error } = await admin.from("pedidos").update(cambios).eq("id", pedido.id);
  if (error) {
    console.error("[swayp] no se pudo actualizar el pedido:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, codigo: pedido.codigo, estado: nuevo ?? pedido.estado });
}

/** Abierta en el navegador, dice si la conexión está lista. No muestra secretos. */
export async function GET() {
  return NextResponse.json({
    secreto_cargado: await estaConfigurada("swayp", ["webhook_secret"]),
    api_cargada: await estaConfigurada("swayp", ["api_token", "base_url", "email"]),
  });
}
