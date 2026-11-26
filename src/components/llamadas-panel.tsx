"use client";

import { MessageCircle, Phone, PhoneCall, Plus, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { actualizarLlamadas } from "@/app/actions";
import { PedidoForm } from "@/components/pedido-form";
import { BOTON_SECUNDARIO, EstadoChip } from "@/components/pedidos-ui";
import { Card, INPUT_CLASS } from "@/components/ui";
import { dayKeyInZone } from "@/lib/fechas";
import { LLAMADAS, estaCerrado, etiquetaDeEtapa, type Llamada } from "@/lib/llamadas";
import type { Pedido, PedidoItem, RolVenta } from "@/lib/pedidos";
import { getSupabaseBrowser } from "@/lib/supabase/browser";

type Fila = {
  lead_id: string;
  nombre: string;
  celular: string | null;
  producto: string | null;
  etapa: string | null;
  etiquetas: string[] | null;
  anuncio: string | null;
  creado_en: string | null;
  llamada: Llamada | null;
  llamada_por_alias: string | null;
  llamada_at: string | null;
  pedido_id: string | null;
  pedido_codigo: string | null;
  pedido_estado: string | null;
  pedido_asesor: string | null;
};

type Filtro = "pendientes" | "todos";

/** Ya se cerró: vendido en Flujos o con pedido en la base (por su celular). */
const cerrado = (f: Fila) => Boolean(f.pedido_codigo) || estaCerrado(f.etapa ?? "");

const COLOR_LLAMADA: Record<Llamada, string> = {
  PRIMERA: "border-sky-500 bg-sky-500 text-white",
  SEGUNDA: "border-violet-500 bg-violet-500 text-white",
  NC: "border-red-500 bg-red-500 text-white",
};

/**
 * Llamadas: los leads que entraron hoy a Flujos y todavía no se cierran, para
 * llamarlos uno por uno. Al costado de cada uno: 1ra llamada, 2da llamada o
 * NC (se marca y se desmarca con un toque) y Crear ficha, que queda enlazada.
 */
export function LlamadasPanel({
  workspaceId,
  timezone,
  rolVenta,
  onNotice,
}: {
  workspaceId: string;
  timezone: string;
  rolVenta: RolVenta;
  onNotice: (mensaje: string) => void;
}) {
  const supabase = getSupabaseBrowser();
  const [dia, setDia] = useState(() => dayKeyInZone(new Date(), timezone));
  const [filas, setFilas] = useState<Fila[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<Filtro>("pendientes");
  const [texto, setTexto] = useState("");
  const [recarga, setRecarga] = useState(0);
  const [trayendo, setTrayendo] = useState(false);
  const [ficha, setFicha] = useState<Fila | null>(null);

  useEffect(() => {
    let vigente = true;
    void (async () => {
      const { data, error: falla } = await supabase.rpc("llamadas_del_dia", { ws: workspaceId, dia });
      if (!vigente) return;
      if (falla) {
        setError(/llamadas_del_dia|does not exist/.test(falla.message) ? "Falta correr el SQL de Llamadas en Supabase (202612130001_llamadas.sql)." : falla.message);
        return;
      }
      setError(null);
      setFilas((data ?? []) as Fila[]);
    })();
    return () => {
      vigente = false;
    };
  }, [supabase, workspaceId, dia, recarga]);

  // Cada minuto se vuelve a mirar: entran leads nuevos durante el día.
  useEffect(() => {
    const reloj = window.setInterval(() => setRecarga((n) => n + 1), 60_000);
    return () => window.clearInterval(reloj);
  }, []);

  const traerDeFlujos = async () => {
    setTrayendo(true);
    const r = await actualizarLlamadas();
    setTrayendo(false);
    if (!r.ok) return setError(r.error);
    onNotice(r.mensaje);
    setRecarga((n) => n + 1);
  };

  const marcar = async (fila: Fila, valor: Llamada) => {
    const nuevo = fila.llamada === valor ? null : valor;
    // Se ve al instante; si falla, se vuelve atrás.
    setFilas((actual) => actual?.map((f) => (f.lead_id === fila.lead_id ? { ...f, llamada: nuevo } : f)) ?? null);
    const { error: falla } = await supabase.rpc("marcar_llamada", { ws: workspaceId, lead: fila.lead_id, valor: nuevo });
    if (falla) {
      setFilas((actual) => actual?.map((f) => (f.lead_id === fila.lead_id ? { ...f, llamada: fila.llamada } : f)) ?? null);
      setError(falla.message);
    }
  };

  const visibles = useMemo(() => {
    const t = texto.trim().toLowerCase();
    return (filas ?? []).filter(
      (f) =>
        (filtro === "todos" || !cerrado(f)) &&
        (!t || f.nombre.toLowerCase().includes(t) || (f.celular ?? "").includes(t) || (f.producto ?? "").toLowerCase().includes(t)),
    );
  }, [filas, filtro, texto]);

  const cuenta = (condicion: (f: Fila) => boolean) => (filas ?? []).filter(condicion).length;
  const pendientes = (filas ?? []).filter((f) => !cerrado(f));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <PhoneCall className="size-6" /> Llamadas
          </h1>
          <p className="text-sm text-neutral-500">Los leads que entraron a Flujos y todavía no se cierran. Llámalos y crea su ficha.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input type="date" value={dia} onChange={(e) => e.target.value && setDia(e.target.value)} className={`${INPUT_CLASS} h-10 w-40`} />
          <button type="button" disabled={trayendo} onClick={() => void traerDeFlujos()} className={`${BOTON_SECUNDARIO} h-10`}>
            <RefreshCw className={`size-4 ${trayendo ? "animate-spin" : ""}`} /> {trayendo ? "Trayendo…" : "Actualizar"}
          </button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Contador titulo="Por llamar" valor={pendientes.filter((f) => !f.llamada).length} tono="amber" />
        <Contador titulo="1ra llamada" valor={pendientes.filter((f) => f.llamada === "PRIMERA").length} tono="sky" />
        <Contador titulo="2da llamada" valor={pendientes.filter((f) => f.llamada === "SEGUNDA").length} tono="violet" />
        <Contador titulo="NC" valor={pendientes.filter((f) => f.llamada === "NC").length} tono="red" />
        <Contador titulo="Ya en la base" valor={cuenta(cerrado)} tono="emerald" />
      </div>

      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-neutral-400" />
            <input value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Buscar nombre, celular o producto" className={`${INPUT_CLASS} h-10 pl-9`} />
          </div>
          <div className="flex gap-1 rounded-xl bg-[#f3f1ea] p-1 text-sm dark:bg-white/5">
            {(
              [
                ["pendientes", `Sin cerrar (${pendientes.length})`],
                ["todos", `Todos (${filas?.length ?? 0})`],
              ] as [Filtro, string][]
            ).map(([id, etiqueta]) => (
              <button
                key={id}
                type="button"
                onClick={() => setFiltro(id)}
                className={`cursor-pointer rounded-lg px-3 py-1.5 font-medium ${filtro === id ? "bg-white shadow-sm dark:bg-white/15" : "text-neutral-600 dark:text-neutral-300"}`}
              >
                {etiqueta}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="mt-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-500/10 dark:text-red-200">{error}</p>}
        {!filas && !error && <p className="mt-4 text-sm text-neutral-500">Cargando…</p>}
        {filas && filas.length === 0 && !error && (
          <p className="mt-4 text-sm text-neutral-500">Todavía no hay leads de este día. Toca Actualizar para traerlos de Flujos.</p>
        )}
        {filas && filas.length > 0 && visibles.length === 0 && <p className="mt-4 text-sm text-neutral-500">No hay leads con ese filtro. 👍</p>}

        {visibles.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-[#e7e3d6] text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-white/10">
                  <th className="px-2 py-2">Hora</th>
                  <th className="px-2 py-2">Cliente</th>
                  <th className="px-2 py-2">Celular</th>
                  <th className="px-2 py-2">Producto</th>
                  <th className="px-2 py-2">Etapa / etiquetas</th>
                  <th className="px-2 py-2">Llamada</th>
                  <th className="px-2 py-2">Ficha</th>
                </tr>
              </thead>
              <tbody>
                {visibles.map((f) => (
                  <tr key={f.lead_id} className="border-b border-[#efece2] align-middle last:border-0 dark:border-white/5">
                    <td className="whitespace-nowrap px-2 py-2 text-xs text-neutral-500">
                      {f.creado_en ? new Date(f.creado_en).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", timeZone: timezone }) : "—"}
                    </td>
                    <td className="px-2 py-2 font-semibold">{f.nombre}</td>
                    <td className="whitespace-nowrap px-2 py-2">
                      {f.celular ? (
                        <span className="flex items-center gap-2">
                          <a href={`tel:${f.celular}`} className="font-mono underline" title="Llamar">
                            {f.celular}
                          </a>
                          <a href={`https://wa.me/51${f.celular}`} target="_blank" rel="noreferrer" title="Abrir WhatsApp" className="text-emerald-600">
                            <MessageCircle className="size-4" />
                          </a>
                        </span>
                      ) : (
                        <span className="text-xs text-neutral-400">sin celular</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-xs font-medium">{f.producto ?? "—"}</td>
                    <td className="px-2 py-2">
                      <span className="flex flex-wrap gap-1">
                        {f.etapa && (
                          <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] dark:bg-white/10">{etiquetaDeEtapa(f.etapa)}</span>
                        )}
                        {(f.etiquetas ?? []).map((e) => (
                          <span key={e} className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-900 dark:bg-amber-400/15 dark:text-amber-200">
                            {e}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      <span className="flex gap-1">
                        {LLAMADAS.map((l) => {
                          const activa = f.llamada === l.valor;
                          return (
                            <button
                              key={l.valor}
                              type="button"
                              onClick={() => void marcar(f, l.valor)}
                              title={activa ? "Toca de nuevo para desmarcar" : `Marcar ${l.texto}`}
                              className={`cursor-pointer whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors ${
                                activa ? COLOR_LLAMADA[l.valor] : "border-[#ddd8c9] bg-white text-neutral-600 hover:bg-neutral-50 dark:border-white/10 dark:bg-white/5 dark:text-neutral-300"
                              }`}
                            >
                              {l.texto}
                            </button>
                          );
                        })}
                      </span>
                      {f.llamada && f.llamada_por_alias && <span className="mt-0.5 block text-[10px] text-neutral-400">por {f.llamada_por_alias}</span>}
                    </td>
                    <td className="px-2 py-2">
                      {f.pedido_codigo ? (
                        <span className="flex flex-wrap items-center gap-1 text-xs">
                          <b className="font-mono">{f.pedido_codigo}</b>
                          {f.pedido_estado && <EstadoChip estado={f.pedido_estado} />}
                          {f.pedido_asesor && <span className="text-neutral-500">{f.pedido_asesor}</span>}
                        </span>
                      ) : (
                        <button type="button" onClick={() => setFicha(f)} className={`${BOTON_SECUNDARIO} px-2.5 py-1 text-xs`}>
                          <Plus className="size-3.5" /> Crear ficha
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 flex items-center gap-1 text-xs text-neutral-500">
          <Phone className="size-3.5" /> Los leads se traen de Flujos cada 5 minutos. &quot;Sin cerrar&quot; oculta los que ya se vendieron en Flujos o ya
          tienen un pedido en la base (por su celular).
        </p>
      </Card>

      {ficha && (
        <PedidoForm
          workspaceId={workspaceId}
          timezone={timezone}
          rolVenta={rolVenta}
          pedido={null}
          inicial={
            {
              cliente: ficha.nombre === "Sin nombre" ? "" : ficha.nombre,
              celular: ficha.celular,
              canal: "WASAP IA",
              cerrado_por: "ASESOR",
              nota: `Lead de Flujos (llamada)${ficha.producto ? ` · le interesa ${ficha.producto}` : ""}`,
              items: ficha.producto ? ([{ producto: ficha.producto, cantidad: 1 }] as PedidoItem[]) : [],
            } as Partial<Pedido> & { items?: PedidoItem[] }
          }
          onClose={() => setFicha(null)}
          onSaved={(mensaje, guardado) => {
            const lead = ficha.lead_id;
            setFicha(null);
            onNotice(mensaje);
            void (async () => {
              if (guardado) await supabase.rpc("enlazar_llamada", { ws: workspaceId, lead, pedido: guardado.id });
              setRecarga((n) => n + 1);
            })();
          }}
        />
      )}
    </div>
  );
}

const TONOS = {
  amber: "before:bg-amber-500",
  sky: "before:bg-sky-500",
  violet: "before:bg-violet-500",
  red: "before:bg-red-500",
  emerald: "before:bg-emerald-500",
} as const;

function Contador({ titulo, valor, tono }: { titulo: string; valor: number; tono: keyof typeof TONOS }) {
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border border-[#e7e3d6] bg-white p-3 pl-4 shadow-sm before:absolute before:inset-y-0 before:left-0 before:w-1 dark:border-white/10 dark:bg-white/5 ${TONOS[tono]}`}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{titulo}</p>
      <p className="text-2xl font-semibold tabular-nums">{valor}</p>
    </div>
  );
}
