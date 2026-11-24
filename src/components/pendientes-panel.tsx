"use client";

import { RefreshCw, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";

import { buscarPedidosDeFlujos } from "@/app/actions";
import { PedidoForm } from "@/components/pedido-form";
import { BOTON_SECUNDARIO } from "@/components/pedidos-ui";
import { PRIMARY_BUTTON_CLASS } from "@/components/ui";
import { soles, type Pedido, type PedidoItem, type RolVenta } from "@/lib/pedidos";
import { getSupabaseBrowser } from "@/lib/supabase/browser";

type Pendiente = {
  id: string;
  origen: string;
  estado: "pendiente" | "programado" | "descartado";
  cliente: string | null;
  celular: string | null;
  monto: number | null;
  resumen: string | null;
  propuesta: Partial<Pedido> & { items?: PedidoItem[]; nota?: string };
  creado_en_origen: string | null;
  pedido_id: string | null;
};

/**
 * Pedidos pendientes: las ventas que cerró la IA en Flujos, esperando que
 * alguien las revise. "Programar" abre la ficha ya completada; al guardar nace
 * el pedido con su código WED. "Descartar" las saca de la lista.
 */
export function PendientesPanel({
  workspaceId,
  timezone,
  rolVenta,
  onNotice,
}: {
  workspaceId: string;
  timezone: string;
  rolVenta: RolVenta;
  onNotice: (message: string) => void;
}) {
  const supabase = getSupabaseBrowser();
  const [ver, setVer] = useState<"pendiente" | "todos">("pendiente");
  const [lista, setLista] = useState<Pendiente[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);
  const [buscando, setBuscando] = useState(false);
  const [programando, setProgramando] = useState<Pendiente | null>(null);

  useEffect(() => {
    let vigente = true;
    void (async () => {
      let consulta = supabase
        .from("pedidos_pendientes")
        .select("id, origen, estado, cliente, celular, monto, resumen, propuesta, creado_en_origen, pedido_id")
        .eq("workspace_id", workspaceId)
        .order("creado_en_origen", { ascending: false })
        .limit(200);
      if (ver === "pendiente") consulta = consulta.eq("estado", "pendiente");
      const { data, error: falla } = await consulta;
      if (!vigente) return;
      setError(
        falla
          ? /pedidos_pendientes/.test(falla.message)
            ? "Falta correr el SQL de pedidos pendientes en Supabase."
            : falla.message
          : null,
      );
      setLista((data ?? []) as Pendiente[]);
    })();
    return () => {
      vigente = false;
    };
  }, [supabase, workspaceId, ver, recarga]);

  const buscar = async () => {
    setBuscando(true);
    const res = await buscarPedidosDeFlujos();
    setBuscando(false);
    onNotice(res.ok ? res.mensaje : res.error);
    setRecarga((n) => n + 1);
  };

  const resolver = async (p: Pendiente, estado: "programado" | "descartado", pedidoId: string | null = null) => {
    const { data: sesion } = await supabase.auth.getUser();
    const { error: falla } = await supabase
      .from("pedidos_pendientes")
      .update({ estado, pedido_id: pedidoId, resuelto_por: sesion.user?.id ?? null, resuelto_at: new Date().toISOString() })
      .eq("id", p.id);
    if (falla) onNotice(falla.message);
    setRecarga((n) => n + 1);
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
          <Sparkles className="size-4 text-amber-600" /> Ventas que cerró la IA en Flujos. Revisa cada una y prográmala.
        </p>
        <div className="flex gap-2">
          <select
            value={ver}
            onChange={(e) => {
              setLista(null);
              setVer(e.target.value as "pendiente" | "todos");
            }}
            className="h-10 rounded-xl border border-[#ddd8c9] bg-[#f9f8f3] px-2.5 text-sm dark:border-white/10 dark:bg-white/5"
          >
            <option value="pendiente">Pendientes</option>
            <option value="todos">Todos</option>
          </select>
          <button type="button" disabled={buscando} onClick={() => void buscar()} className={BOTON_SECUNDARIO}>
            <RefreshCw className={`size-4 ${buscando ? "animate-spin" : ""}`} /> Buscar ahora
          </button>
        </div>
      </div>

      {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-500/10 dark:text-red-200">{error}</p>}
      {!lista && !error && <p className="text-sm text-neutral-500">Cargando…</p>}
      {lista && lista.length === 0 && !error && (
        <p className="rounded-2xl bg-[#f9f8f3] px-4 py-10 text-center text-sm text-neutral-500 dark:bg-white/5">
          {ver === "pendiente" ? "No hay ventas de la IA esperando. Llegan solas cada 5 minutos." : "Todavía no llegó ninguna."}
        </p>
      )}

      <ul className="space-y-3">
        {lista?.map((p) => {
          const pr = p.propuesta ?? {};
          return (
            <li key={p.id} className="rounded-2xl bg-[#f9f8f3] p-4 dark:bg-white/5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold">
                    {p.cliente ?? "Cliente"} <span className="font-normal text-neutral-500">· {p.celular ?? "sin celular"}</span>
                  </p>
                  <p className="mt-0.5 text-sm">{p.resumen || "—"}</p>
                  <p className="mt-1 text-xs text-neutral-500">
                    {[soles(p.monto), pr.adelanto ? `adelanto ${soles(pr.adelanto)}` : null, pr.destino, pr.provincia, pr.distrito, pr.courier]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <p className="mt-1 text-xs text-neutral-500">
                    {p.creado_en_origen ? new Date(p.creado_en_origen).toLocaleString("es-PE", { timeZone: timezone }) : ""}
                    {p.estado !== "pendiente" && ` · ${p.estado === "programado" ? "Programado" : "Descartado"}`}
                  </p>
                </div>
                {p.estado === "pendiente" && (
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setProgramando(p)} className={PRIMARY_BUTTON_CLASS}>
                      Programar
                    </button>
                    <button type="button" onClick={() => void resolver(p, "descartado")} className={BOTON_SECUNDARIO}>
                      <X className="size-4" /> Descartar
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {programando && (
        <PedidoForm
          workspaceId={workspaceId}
          timezone={timezone}
          rolVenta={rolVenta}
          pedido={null}
          inicial={programando.propuesta}
          onClose={() => setProgramando(null)}
          onSaved={(mensaje, guardado) => {
            const pendiente = programando;
            setProgramando(null);
            onNotice(mensaje);
            if (guardado) void resolver(pendiente, "programado", guardado.id);
          }}
        />
      )}
    </div>
  );
}
