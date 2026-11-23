import { NextResponse, type NextRequest } from "next/server";

import { credenciales, estaConfigurada } from "@/lib/integraciones-server";
import { pedidoDesdeShopify, verificarFirmaShopify, type PedidoShopify } from "@/lib/shopify";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

// node:crypto y la service-role key exigen runtime Node, no Edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Shopify avisa acá cada pedido nuevo (webhook "Order creation").
 *
 * Se verifica la firma con el código que muestra Shopify, se arma el pedido y
 * se guarda. Si Shopify reintenta el aviso, `shopify_id` impide el duplicado.
 * Responde 200 rápido: Shopify reintenta (y termina dando de baja el webhook)
 * si no le contestan en unos segundos.
 */
export async function POST(request: NextRequest) {
  const conexion = await credenciales("shopify", ["webhook_secret"]);
  if (!conexion.ok) {
    console.error("[shopify]", conexion.error);
    return NextResponse.json({ error: conexion.error }, { status: 500 });
  }

  // La firma se calcula sobre el cuerpo tal cual llegó: hay que leerlo como texto.
  const cuerpo = await request.text();
  if (!verificarFirmaShopify(cuerpo, request.headers.get("x-shopify-hmac-sha256"), conexion.valores.webhook_secret)) {
    console.warn("[shopify] firma inválida");
    return NextResponse.json({ error: "Firma inválida: revisa el código de firma en Configuración → Conexiones." }, { status: 401 });
  }

  const tema = request.headers.get("x-shopify-topic") ?? "";
  if (tema && tema !== "orders/create") {
    return NextResponse.json({ ok: true, ignorado: `evento ${tema}` });
  }

  let pedido: PedidoShopify;
  try {
    pedido = JSON.parse(cuerpo) as PedidoShopify;
  } catch {
    return NextResponse.json({ error: "El cuerpo no es JSON." }, { status: 400 });
  }
  if (!pedido?.id) return NextResponse.json({ ok: true, ignorado: "sin id de pedido" });

  const admin = getSupabaseAdmin();
  // Una instalación, un workspace: el más antiguo.
  const { data: workspace } = await admin
    .from("workspaces")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!workspace) return NextResponse.json({ error: "Todavía no hay workspace." }, { status: 500 });

  const { data: productos } = await admin.from("productos").select("nombre").eq("workspace_id", workspace.id);
  const { fila, items } = pedidoDesdeShopify(pedido, {
    asesor: (conexion.valores.asesor ?? "").trim().toUpperCase(),
    marcaLanding: conexion.valores.marca_landing ?? "easysell",
    catalogo: (productos ?? []).map((p) => p.nombre as string),
  });

  // ¿Ya está? Shopify reintenta el aviso si tardamos. Se mira antes de
  // insertar porque el código WED se asigna al insertar: un "insertar o
  // ignorar" gastaría un número aunque no creara el pedido.
  const { data: existente } = await admin
    .from("pedidos")
    .select("codigo")
    .eq("workspace_id", workspace.id)
    .eq("shopify_id", fila.shopify_id)
    .maybeSingle();
  if (existente) return NextResponse.json({ ok: true, repetido: existente.codigo });

  const { data: nuevo, error } = await admin
    .from("pedidos")
    .insert({ ...fila, workspace_id: workspace.id, codigo: "" })
    .select("id, codigo")
    .single();
  if (error || !nuevo) {
    // Dos avisos del mismo pedido al mismo tiempo: el segundo choca con el
    // primero. No es un error y no gasta código (la inserción se deshace entera).
    if (error?.code === "23505") return NextResponse.json({ ok: true, repetido: true });
    console.error("[shopify] no se pudo guardar:", error?.message);
    return NextResponse.json({ error: error?.message ?? "No se pudo guardar." }, { status: 500 });
  }

  if (items.length) {
    await admin
      .from("pedido_items")
      .insert(items.map((item) => ({ ...item, pedido_id: nuevo.id, workspace_id: workspace.id })));
  }
  return NextResponse.json({ ok: true, codigo: nuevo.codigo });
}

/** Abierta en el navegador, dice si la conexión está lista. No muestra secretos. */
export async function GET() {
  return NextResponse.json({
    codigo_de_firma_cargado: await estaConfigurada("shopify", ["webhook_secret"]),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  });
}
