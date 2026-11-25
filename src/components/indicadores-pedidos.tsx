"use client";

import { AlertTriangle, ChevronRight, Clock, PackageCheck, Truck, UserRoundCheck } from "lucide-react";
import { useEffect, useState } from "react";

import { EstadoUnico } from "@/components/pedidos-ui";
import { Modal } from "@/components/ui";
import type { Pedido } from "@/lib/pedidos";
import { getSupabaseBrowser } from "@/lib/supabase/browser";

type Indicadores = {
  general: boolean;
  gestionados: { ids: string[]; creados: string[]; programados: string[]; modificados: string[] };
  entregados: string[];
  confirmados: { ids: string[]; atrasados: string[] };
  provincia: { transito: string[]; destino: string[] };
};

type Lista = { titulo: string; ids: string[] };

const TONOS = {
  sky: { borde: "before:bg-sky-500", icono: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300" },
  emerald: { borde: "before:bg-emerald-500", icono: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" },
  amber: { borde: "before:bg-amber-500", icono: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300" },
  violet: { borde: "before:bg-violet-500", icono: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300" },
} as const;

/**
 * Los indicadores de arriba de la base. Cada asesora ve los suyos; el
 * administrador y el encargado, los de todo el equipo. Cada número se toca y
 * muestra los pedidos que cuenta.
 */
export function IndicadoresPedidos({
  workspaceId,
  recarga,
  onAbrir,
}: {
  workspaceId: string;
  recarga: number;
  onAbrir: (pedido: Pedido) => void;
}) {
  const supabase = getSupabaseBrowser();
  const [datos, setDatos] = useState<Indicadores | null>(null);
  const [lista, setLista] = useState<Lista | null>(null);

  useEffect(() => {
    let vigente = true;
    void (async () => {
      const { data, error } = await supabase.rpc("indicadores_de_pedidos", { ws: workspaceId });
      // Si falta el SQL, simplemente no se muestran.
      if (vigente && !error) setDatos(data as Indicadores);
    })();
    return () => {
      vigente = false;
    };
  }, [supabase, workspaceId, recarga]);

  if (!datos) return null;
  const quien = datos.general ? "del equipo" : "tuyos";
  const abrir = (titulo: string, ids: string[]) => ids.length && setLista({ titulo, ids });

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tarjeta
          tono="sky"
          icono={<UserRoundCheck className="size-5" />}
          titulo="Leads gestionados hoy"
          numero={datos.gestionados.ids.length}
          detalle={datos.general ? "Lo que el equipo creó, programó o cambió hoy" : "Los que creaste, programaste o cambiaste hoy"}
          onClick={() => abrir("Leads gestionados hoy", datos.gestionados.ids)}
          partes={[
            { texto: "Programados", ids: datos.gestionados.programados },
            { texto: "Creados", ids: datos.gestionados.creados },
            { texto: "Con cambios", ids: datos.gestionados.modificados },
          ]}
          onParte={(texto, ids) => abrir(`${texto} hoy`, ids)}
        />
        <Tarjeta
          tono="emerald"
          icono={<PackageCheck className="size-5" />}
          titulo="Entregados hoy"
          numero={datos.entregados.length}
          detalle={`Pedidos ${quien} que pasaron a ENTREGADO hoy`}
          onClick={() => abrir("Entregados hoy", datos.entregados)}
        />
        <Tarjeta
          tono="amber"
          icono={<Clock className="size-5" />}
          titulo="Confirmados pendientes"
          numero={datos.confirmados.ids.length}
          detalle="Siguen en CONFIRMADO: revísalos y atiéndelos"
          onClick={() => abrir("Confirmados pendientes", datos.confirmados.ids)}
          alerta={
            datos.confirmados.atrasados.length
              ? {
                  texto: `${datos.confirmados.atrasados.length} de días anteriores`,
                  onClick: () => abrir("Confirmados de días anteriores", datos.confirmados.atrasados),
                }
              : undefined
          }
        />
        <Tarjeta
          tono="violet"
          icono={<Truck className="size-5" />}
          titulo="Pedidos a provincia"
          numero={datos.provincia.transito.length + datos.provincia.destino.length}
          detalle="En camino y esperando en la agencia"
          onClick={() => abrir("Pedidos a provincia", [...datos.provincia.transito, ...datos.provincia.destino])}
          partes={[
            { texto: "En tránsito", ids: datos.provincia.transito },
            { texto: "En destino", ids: datos.provincia.destino },
          ]}
          onParte={(texto, ids) => abrir(`Provincia: ${texto.toLowerCase()}`, ids)}
        />
      </div>

      {lista && (
        <ListaDePedidos
          lista={lista}
          onClose={() => setLista(null)}
          onAbrir={(p) => {
            setLista(null);
            onAbrir(p);
          }}
        />
      )}
    </>
  );
}

function Tarjeta({
  tono,
  icono,
  titulo,
  numero,
  detalle,
  onClick,
  partes,
  onParte,
  alerta,
}: {
  tono: keyof typeof TONOS;
  icono: React.ReactNode;
  titulo: string;
  numero: number;
  detalle: string;
  onClick: () => void;
  partes?: { texto: string; ids: string[] }[];
  onParte?: (texto: string, ids: string[]) => void;
  alerta?: { texto: string; onClick: () => void };
}) {
  const t = TONOS[tono];
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border border-[#e7e3d6] bg-white p-4 shadow-sm transition-shadow before:absolute before:inset-y-0 before:left-0 before:w-1 hover:shadow-md dark:border-white/10 dark:bg-white/5 ${t.borde}`}
    >
      <button type="button" onClick={onClick} className="group flex w-full cursor-pointer items-start gap-3 text-left">
        <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${t.icono}`}>{icono}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{titulo}</span>
          <span className="mt-0.5 flex items-baseline gap-1">
            <span className="text-3xl font-semibold tabular-nums">{numero}</span>
            <ChevronRight className="size-4 text-neutral-300 transition-transform group-hover:translate-x-0.5" />
          </span>
          <span className="block text-xs text-neutral-500">{detalle}</span>
        </span>
      </button>
      {(partes || alerta) && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {partes?.map((p) => (
            <button
              key={p.texto}
              type="button"
              disabled={!p.ids.length}
              onClick={() => onParte?.(p.texto, p.ids)}
              className="cursor-pointer rounded-full bg-[#f3f1ea] px-2.5 py-1 text-xs font-medium hover:bg-[#e9e5d8] disabled:cursor-default disabled:opacity-50 dark:bg-white/10 dark:hover:bg-white/15"
            >
              {p.texto} <b className="tabular-nums">{p.ids.length}</b>
            </button>
          ))}
          {alerta && (
            <button
              type="button"
              onClick={alerta.onClick}
              className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-800 hover:bg-red-200 dark:bg-red-500/15 dark:text-red-300"
            >
              <AlertTriangle className="size-3" /> {alerta.texto}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ListaDePedidos({ lista, onClose, onAbrir }: { lista: Lista; onClose: () => void; onAbrir: (p: Pedido) => void }) {
  const supabase = getSupabaseBrowser();
  const [pedidos, setPedidos] = useState<Pedido[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vigente = true;
    void (async () => {
      const todos: Pedido[] = [];
      // De a tandas: una lista larga de ids no entra en una sola dirección.
      for (let i = 0; i < lista.ids.length; i += 150) {
        const { data, error: falla } = await supabase.from("pedidos").select("*").in("id", lista.ids.slice(i, i + 150));
        if (falla) {
          if (vigente) setError(falla.message);
          return;
        }
        todos.push(...((data ?? []) as Pedido[]));
      }
      todos.sort((a, b) => (b.codigo ?? "").localeCompare(a.codigo ?? "", "es", { numeric: true }));
      if (vigente) setPedidos(todos);
    })();
    return () => {
      vigente = false;
    };
  }, [supabase, lista]);

  return (
    <Modal title={`${lista.titulo} (${lista.ids.length})`} onClose={onClose} ancho="max-w-5xl">
      {error && <p className="mt-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-500/10 dark:text-red-200">{error}</p>}
      {!pedidos && !error && <p className="mt-4 text-sm text-neutral-500">Cargando…</p>}
      {pedidos && (
        <div className="mt-4 max-h-[65vh] overflow-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="sticky top-0 bg-[#fbfaf6] dark:bg-neutral-900">
              <tr className="border-b border-[#e7e3d6] text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-white/10">
                <th className="px-2 py-2">Cod</th>
                <th className="px-2 py-2">F. reg</th>
                <th className="px-2 py-2">Cliente</th>
                <th className="px-2 py-2">Pedido</th>
                <th className="px-2 py-2">Estado</th>
                <th className="px-2 py-2">Destino</th>
                <th className="px-2 py-2">Asesor</th>
              </tr>
            </thead>
            <tbody>
              {pedidos.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => onAbrir(p)}
                  className="cursor-pointer border-b border-[#efece2] last:border-0 hover:bg-[#f9f8f3] dark:border-white/5 dark:hover:bg-white/5"
                >
                  <td className="whitespace-nowrap px-2 py-2 font-mono text-xs">{p.codigo}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-xs">{p.fecha_registro}</td>
                  <td className="px-2 py-2 font-semibold">{p.cliente}</td>
                  <td className="max-w-[220px] px-2 py-2 text-xs">{p.pedido}</td>
                  <td className="px-2 py-2">
                    <EstadoUnico pedido={p} />
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-xs">{p.provincia || p.destino || "—"}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-xs">{p.asesor || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-neutral-500">Toca un pedido para abrir su ficha.</p>
        </div>
      )}
    </Modal>
  );
}
