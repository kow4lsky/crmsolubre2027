"use client";

import { Check, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";

import { BOTON_SECUNDARIO, EstadoChip } from "@/components/pedidos-ui";
import { PRIMARY_BUTTON_CLASS } from "@/components/ui";
import type { RolVenta } from "@/lib/pedidos";
import { getSupabaseBrowser } from "@/lib/supabase/browser";

type Solicitud = {
  id: string;
  solicitante: string | null;
  estado_actual: string;
  estado_solicitado: string;
  motivo: string;
  estado: "pendiente" | "aprobada" | "rechazada";
  resuelto_por: string | null;
  resuelto_at: string | null;
  created_at: string;
  pedidos: { codigo: string; cliente: string } | { codigo: string; cliente: string }[] | null;
};

/**
 * El admin ve todas las solicitudes y las resuelve; los demás ven las suyas y
 * en qué quedaron.
 */
export function AutorizacionesPanel({
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
  const esAdmin = rolVenta === "admin";
  const [solo, setSolo] = useState<"pendiente" | "todas">("pendiente");
  const [lista, setLista] = useState<Solicitud[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);

  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    let vigente = true;
    const cargar = async () => {
      let consulta = supabase
        .from("autorizaciones")
        .select("id, solicitante, estado_actual, estado_solicitado, motivo, estado, resuelto_por, resuelto_at, created_at, pedidos(codigo, cliente)")
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: false })
        .limit(200);
      if (solo === "pendiente") consulta = consulta.eq("estado", "pendiente");
      const { data, error: falla } = await consulta;
      if (!vigente) return;
      setError(falla ? falla.message : null);
      setLista((data ?? []) as unknown as Solicitud[]);
      setCargando(false);
    };
    void cargar();
    return () => {
      vigente = false;
    };
  }, [supabase, workspaceId, solo, recarga]);

  const refrescar = () => {
    setCargando(true);
    setRecarga((n) => n + 1);
  };

  const resolver = async (id: string, aprobar: boolean) => {
    setOcupado(id);
    const { error: falla } = await supabase.rpc("resolver_autorizacion", { autorizacion: id, aprobar, nota: null });
    setOcupado(null);
    if (falla) return onNotice(falla.message);
    onNotice(aprobar ? "Aprobada: el pedido ya cambió de estado." : "Solicitud rechazada.");
    refrescar();
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          {esAdmin
            ? "Los cambios de estado que el equipo no puede hacer solo. Aprueba o rechaza cada uno."
            : "Tus pedidos de cambio de estado y en qué quedaron."}
        </p>
        <div className="flex gap-2">
          <select
            value={solo}
            onChange={(e) => {
              setCargando(true);
              setSolo(e.target.value as "pendiente" | "todas");
            }}
            className="h-10 rounded-xl border border-[#ddd8c9] bg-[#f9f8f3] px-2.5 text-sm dark:border-white/10 dark:bg-white/5"
          >
            <option value="pendiente">Pendientes</option>
            <option value="todas">Todas</option>
          </select>
          <button type="button" onClick={refrescar} className={BOTON_SECUNDARIO}>
            <RefreshCw className={`size-4 ${cargando ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-500/10 dark:text-red-200">{error}</p>}

      {!cargando && lista.length === 0 && !error && (
        <p className="rounded-2xl bg-[#f9f8f3] px-4 py-10 text-center text-sm text-neutral-500 dark:bg-white/5">
          {solo === "pendiente" ? "No hay solicitudes pendientes." : "Todavía no hay solicitudes."}
        </p>
      )}

      <ul className="space-y-3">
        {lista.map((s) => {
          const pedido = Array.isArray(s.pedidos) ? s.pedidos[0] : s.pedidos;
          return (
            <li key={s.id} className="rounded-2xl bg-[#f9f8f3] p-4 dark:bg-white/5">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono text-neutral-500">{pedido?.codigo ?? "—"}</span>
                <span className="font-semibold">{pedido?.cliente ?? ""}</span>
                <span className="text-neutral-400">·</span>
                <EstadoChip estado={s.estado_actual} />
                {s.estado_solicitado === s.estado_actual ? (
                  <span className="text-xs font-semibold text-sky-700 dark:text-sky-300">Pide un cambio de datos (edítalo tú)</span>
                ) : (
                  <>
                    <span>→</span>
                    <EstadoChip estado={s.estado_solicitado} />
                  </>
                )}
              </div>
              <p className="mt-2 text-sm">
                <span className="text-neutral-500">{s.solicitante ?? "Alguien"} pidió:</span> {s.motivo}
              </p>
              <p className="mt-1 text-xs text-neutral-500">
                {new Date(s.created_at).toLocaleString("es-PE", { timeZone: timezone })}
                {s.estado !== "pendiente" &&
                  ` · ${s.estado === "aprobada" ? "Aprobada" : "Rechazada"} por ${s.resuelto_por ?? "—"}`}
              </p>
              {esAdmin && s.estado === "pendiente" && (
                <div className="mt-3 flex gap-2">
                  <button type="button" disabled={ocupado === s.id} onClick={() => void resolver(s.id, true)} className={PRIMARY_BUTTON_CLASS}>
                    <Check className="size-4" /> Aprobar
                  </button>
                  <button type="button" disabled={ocupado === s.id} onClick={() => void resolver(s.id, false)} className={BOTON_SECUNDARIO}>
                    <X className="size-4" /> Rechazar
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
