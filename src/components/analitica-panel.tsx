"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { actualizarAnaliticaDeFlujos } from "@/app/actions";
import { BOTON_SECUNDARIO } from "@/components/pedidos-ui";
import { INPUT_CLASS } from "@/components/ui";
import {
  type AnaliticaAsesora,
  type AnaliticaEmpresa,
  RANGOS,
  conversion,
  rangoDe,
  soles,
  sumarAnuncios,
  totalesDelRango,
  type Rango,
} from "@/lib/analitica";
import type { RolVenta } from "@/lib/pedidos";
import { getSupabaseBrowser } from "@/lib/supabase/browser";

const TARJETA = "rounded-2xl border border-neutral-200 bg-white p-4 dark:border-white/10 dark:bg-white/5";
const ETIQUETA = "text-xs font-medium text-neutral-500 dark:text-neutral-400";

/**
 * Analítica: cómo va cada asesora y cómo va la empresa. Los números los arma
 * Postgres (`analitica_asesoras`, `analitica_empresa`): acá sólo se muestran.
 */
export function AnaliticaPanel({
  workspaceId,
  rolVenta,
  onNotice,
}: {
  workspaceId: string;
  rolVenta: RolVenta;
  onNotice: (mensaje: string) => void;
}) {
  const supabase = getSupabaseBrowser();
  const veTodo = rolVenta === "admin" || rolVenta === "encargado";
  const [pestana, setPestana] = useState<"asesoras" | "empresa">("asesoras");
  const [rango, setRango] = useState<Rango>("hoy");
  const [propio, setPropio] = useState({ desde: "", hasta: "" });
  const [diasCaido, setDiasCaido] = useState(2);
  const [asesoras, setAsesoras] = useState<AnaliticaAsesora[] | null>(null);
  const [empresa, setEmpresa] = useState<AnaliticaEmpresa | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [recarga, setRecarga] = useState(0);
  const [actualizandoFlujos, setActualizandoFlujos] = useState(false);

  const fechas = useMemo(() => rangoDe(rango, new Date(), propio), [rango, propio]);

  useEffect(() => {
    let vigente = true;
    const traer = async () => {
      setCargando(true);
      setError(null);
      const args = { ws: workspaceId, desde: fechas.desde, hasta: fechas.hasta, dias_caido: diasCaido };
      const [a, e] = await Promise.all([
        supabase.rpc("analitica_asesoras", args),
        veTodo && pestana === "empresa" ? supabase.rpc("analitica_empresa", args) : Promise.resolve({ data: null, error: null }),
      ]);
      if (!vigente) return;
      const falla = a.error ?? e.error;
      if (falla) {
        setError(
          /analitica_|flujos_diario|dia_de_lima/.test(falla.message)
            ? "Falta correr el SQL de la Analítica en Supabase (202612030001_analitica.sql)."
            : falla.message,
        );
      } else {
        setAsesoras((a.data ?? []) as AnaliticaAsesora[]);
        if (e.data) setEmpresa(e.data as AnaliticaEmpresa);
      }
      setCargando(false);
    };
    void traer();
    return () => {
      vigente = false;
    };
  }, [supabase, workspaceId, fechas, diasCaido, pestana, veTodo, recarga]);

  const refrescarFlujos = async () => {
    setActualizandoFlujos(true);
    const r = await actualizarAnaliticaDeFlujos();
    setActualizandoFlujos(false);
    onNotice(r.ok ? r.mensaje : r.error);
    if (r.ok) setRecarga((n) => n + 1);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        {veTodo && (
          <div className="mr-2 flex rounded-xl border border-neutral-200 bg-white p-1 dark:border-white/10 dark:bg-white/5">
            {(["asesoras", "empresa"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPestana(p)}
                className={`cursor-pointer rounded-lg px-4 py-1.5 text-sm font-semibold ${pestana === p ? "bg-amber-500 text-neutral-950" : "text-neutral-600 dark:text-neutral-300"}`}
              >
                {p === "asesoras" ? "Asesoras" : "Empresa"}
              </button>
            ))}
          </div>
        )}
        <label>
          <span className={`${ETIQUETA} mb-1 block`}>Periodo</span>
          <select value={rango} onChange={(e) => setRango(e.target.value as Rango)} className={`${INPUT_CLASS} h-10`}>
            {RANGOS.map((r) => (
              <option key={r.valor} value={r.valor}>
                {r.nombre}
              </option>
            ))}
          </select>
        </label>
        {rango === "propio" && (
          <>
            <label>
              <span className={`${ETIQUETA} mb-1 block`}>Desde</span>
              <input type="date" value={propio.desde} onChange={(e) => setPropio((p) => ({ ...p, desde: e.target.value }))} className={`${INPUT_CLASS} h-10`} />
            </label>
            <label>
              <span className={`${ETIQUETA} mb-1 block`}>Hasta</span>
              <input type="date" value={propio.hasta} onChange={(e) => setPropio((p) => ({ ...p, hasta: e.target.value }))} className={`${INPUT_CLASS} h-10`} />
            </label>
          </>
        )}
        <label>
          <span className={`${ETIQUETA} mb-1 block`}>Caído: confirmado sin tocar hace</span>
          <select value={diasCaido} onChange={(e) => setDiasCaido(Number(e.target.value))} className={`${INPUT_CLASS} h-10`}>
            {[1, 2, 3, 5, 7].map((d) => (
              <option key={d} value={d}>
                {d} {d === 1 ? "día" : "días"} o más
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => setRecarga((n) => n + 1)} className={`${BOTON_SECUNDARIO} h-10`}>
          <RefreshCw className={`size-4 ${cargando ? "animate-spin" : ""}`} /> Actualizar
        </button>
        <p className="w-full text-xs text-neutral-500">
          Del {fechas.desde} al {fechas.hasta} (hora de Lima). Pendientes y caídos son la foto de <b>ahora</b>, sin importar el periodo.
        </p>
      </div>

      {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-500/10 dark:text-red-200">{error}</p>}

      {pestana === "asesoras" && asesoras && <VistaAsesoras asesoras={asesoras} />}
      {pestana === "empresa" && empresa && (
        <VistaEmpresa empresa={empresa} asesoras={asesoras ?? []} onActualizarFlujos={refrescarFlujos} actualizando={actualizandoFlujos} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------- asesoras */

/** Las asesoras que alguien escondió de su vista. Se recuerda en este navegador. */
const OCULTAS = "crm-solubre:analitica-ocultas";

function leerOcultas(): string[] {
  try {
    const guardadas = JSON.parse(window.localStorage.getItem(OCULTAS) ?? "[]");
    return Array.isArray(guardadas) ? guardadas.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function VistaAsesoras({ asesoras: todas }: { asesoras: AnaliticaAsesora[] }) {
  const [ocultas, setOcultas] = useState<string[]>(() => (typeof window === "undefined" ? [] : leerOcultas()));
  const alternar = (alias: string) =>
    setOcultas((actual) => {
      const nuevas = actual.includes(alias) ? actual.filter((a) => a !== alias) : [...actual, alias];
      try {
        window.localStorage.setItem(OCULTAS, JSON.stringify(nuevas));
      } catch {
        // Sin almacenamiento igual funciona: sólo no se recuerda.
      }
      return nuevas;
    });
  const asesoras = todas.filter((a) => !ocultas.includes(a.alias));

  if (todas.length === 0) {
    return <p className={TARJETA}>No hay asesoras en el equipo. Se agregan en Configuración → Usuarios, con rol de asesora y alias.</p>;
  }
  return (
    <div className="space-y-4">
      {todas.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-neutral-500">Ver:</span>
          {todas.map((a) => {
            const visible = !ocultas.includes(a.alias);
            return (
              <button
                key={a.alias}
                type="button"
                onClick={() => alternar(a.alias)}
                className={`cursor-pointer rounded-full border px-2.5 py-1 font-semibold ${visible ? "border-amber-500 bg-amber-500 text-neutral-950" : "border-neutral-300 text-neutral-500 dark:border-white/20"}`}
              >
                {a.alias}
              </button>
            );
          })}
        </div>
      )}
      <div className={`${TARJETA} overflow-x-auto p-0`}>
        <table className="w-full min-w-[860px] text-sm">
          <thead className="text-left text-xs text-neutral-500">
            <tr className="border-b border-neutral-200 dark:border-white/10">
              <th className="p-3">Asesora</th>
              <th className="p-3 text-right">Ingresó al CRM</th>
              <th className="p-3 text-right">Cerró ella / IA</th>
              <th className="p-3 text-right">Le llegaron</th>
              <th className="p-3 text-right">Gestionó (no nuevos)</th>
              <th className="p-3 text-right">Confirmó</th>
              <th className="p-3 text-right">Entregó</th>
              <th className="p-3 text-right">Pendientes hoy</th>
              <th className="p-3 text-right">Caídos hoy</th>
            </tr>
          </thead>
          <tbody>
            {asesoras.map((a) => (
              <tr key={a.alias} className="border-b border-neutral-100 last:border-0 dark:border-white/5">
                <td className="p-3 font-semibold">{a.alias}</td>
                <td className="p-3 text-right tabular-nums">{a.creados}</td>
                <td className="p-3 text-right tabular-nums">
                  {a.creados_por_cierre.ASESOR ?? 0} / {a.creados_por_cierre.IA ?? 0}
                </td>
                <td className="p-3 text-right tabular-nums">{a.recibidos}</td>
                <td className="p-3 text-right tabular-nums">{a.gestionados}</td>
                <td className="p-3 text-right tabular-nums">{a.confirmados}</td>
                <td className="p-3 text-right tabular-nums">
                  {a.entregados} <span className="text-xs text-neutral-500">{soles(a.entregados_monto)}</span>
                </td>
                <td className="p-3 text-right tabular-nums text-amber-700 dark:text-amber-300">
                  {a.pendientes.total} <span className="text-xs">{soles(a.pendientes.monto)}</span>
                </td>
                <td className="p-3 text-right tabular-nums text-red-700 dark:text-red-300">
                  {a.caidos.total} <span className="text-xs">{soles(a.caidos.monto)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {asesoras.map((a) => (
          <FichaAsesora key={a.alias} a={a} />
        ))}
      </div>
    </div>
  );
}

function Chips({ valores, vacio = "—" }: { valores: Record<string, number>; vacio?: string }) {
  const lista = Object.entries(valores).sort((x, y) => y[1] - x[1]);
  if (lista.length === 0) return <span className="text-xs text-neutral-400">{vacio}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {lista.map(([nombre, n]) => (
        <span key={nombre} className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs dark:bg-white/10">
          {nombre} <b>{n}</b>
        </span>
      ))}
    </span>
  );
}

function FichaAsesora({ a }: { a: AnaliticaAsesora }) {
  const p = a.pendientes;
  return (
    <section className={`${TARJETA} space-y-3 text-sm`}>
      <h3 className="text-base font-bold">{a.alias}</h3>

      <div>
        <p className={ETIQUETA}>
          Ingresó al CRM: <b className="text-neutral-900 dark:text-white">{a.creados}</b> pedidos ({soles(a.creados_monto)}), según el estado
          en que los creó
        </p>
        <Chips valores={a.creados_por_estado} />
        <p className={`${ETIQUETA} mt-1`}>Quién cerró la venta (registrado por)</p>
        <Chips valores={a.creados_por_cierre} />
      </div>

      {a.recibidos > 0 && (
        <div>
          <p className={ETIQUETA}>
            Le llegaron sin crearlos ella: <b className="text-neutral-900 dark:text-white">{a.recibidos}</b>
          </p>
          <Chips valores={a.recibidos_por_canal} />
        </div>
      )}

      <div>
        <p className={ETIQUETA}>
          Gestionó pedidos que no eran nuevos: <b className="text-neutral-900 dark:text-white">{a.gestionados}</b>. Los pasó a:
        </p>
        <Chips valores={a.movidos_a} vacio="No cambió estados" />
      </div>

      <p className={ETIQUETA}>
        Confirmó <b className="text-neutral-900 dark:text-white">{a.confirmados}</b> · Entregó{" "}
        <b className="text-neutral-900 dark:text-white">{a.entregados}</b> ({soles(a.entregados_monto)})
      </p>

      <div className="rounded-xl bg-amber-50 p-3 dark:bg-amber-400/10">
        <p className="font-semibold text-amber-800 dark:text-amber-200">
          Sin confirmar hoy: {p.total} · {soles(p.monto)}
        </p>
        <p className="mt-0.5 text-xs text-amber-900/80 dark:text-amber-100/80">
          Volver a llamar {p.volver_a_llamar} · Coordinación {p.coordinacion} · Llamada vencida {p.llamada_vencida} · Sin fecha de
          llamada {p.sin_llamada} · Con más de 7 días {p.mas_de_7_dias}
        </p>
      </div>

      <div className="rounded-xl bg-red-50 p-3 dark:bg-red-500/10">
        <p className="font-semibold text-red-800 dark:text-red-200">
          Caídos: {a.caidos.total} · {soles(a.caidos.monto)}
        </p>
        <p className="mt-0.5 text-xs text-red-900/80 dark:text-red-100/80">Confirmados que nadie volvió a tocar ni pasaron a otro estado.</p>
        {a.caidos.codigos.length > 0 && (
          <p className="mt-1 flex flex-wrap gap-1">
            {a.caidos.codigos.map((c) => (
              <a key={c} href={`/?vista=pedidos&pedido=${encodeURIComponent(c)}`} className="rounded bg-white px-1.5 py-0.5 text-xs font-semibold hover:underline dark:bg-white/10">
                {c}
              </a>
            ))}
            {a.caidos.total > a.caidos.codigos.length && <span className="text-xs">y {a.caidos.total - a.caidos.codigos.length} más</span>}
          </p>
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- empresa */

function Dato({ titulo, valor, detalle, tono = "" }: { titulo: string; valor: string | number; detalle?: string; tono?: string }) {
  return (
    <div className={`${TARJETA} ${tono}`}>
      <p className={ETIQUETA}>{titulo}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{valor}</p>
      {detalle && <p className="mt-0.5 text-xs text-neutral-500">{detalle}</p>}
    </div>
  );
}

function VistaEmpresa({
  empresa,
  asesoras,
  onActualizarFlujos,
  actualizando,
}: {
  empresa: AnaliticaEmpresa;
  asesoras: AnaliticaAsesora[];
  onActualizarFlujos: () => void;
  actualizando: boolean;
}) {
  const t = totalesDelRango(empresa);
  const h = empresa.hoy;
  const anuncios = sumarAnuncios(empresa.dias);
  const conFlujos = empresa.dias.some((d) => d.flujos);
  const estados = Object.entries(empresa.estados_del_rango).sort((a, b) => b[1].n - a[1].n);
  const registradosDelRango = estados.reduce((s, [, v]) => s + v.n, 0);
  const ultimaFlujos = empresa.dias.map((d) => d.flujos?.actualizado_at).filter(Boolean).sort().at(-1);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Dato
          titulo="Sin confirmar (VOLVER A LLAMAR + COORDINACIÓN)"
          valor={soles(h.pendientes_monto)}
          detalle={`${h.pendientes} pedidos · ${h.pendientes_mas_de_7_dias} con más de 7 días`}
          tono="bg-amber-50! dark:bg-amber-400/10!"
        />
        <Dato titulo="Caídos (confirmados sin tocar)" valor={soles(h.caidos_monto)} detalle={`${h.caidos} pedidos`} tono="bg-red-50! dark:bg-red-500/10!" />
        <Dato titulo="En camino (confirmado, tránsito, oficina)" valor={soles(h.en_camino_monto)} detalle={`${h.en_camino} pedidos`} />
        <Dato titulo="Ventas de la IA sin programar" valor={h.ia_sin_programar} detalle="En Pedidos pendientes" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Dato titulo="Registrados en el periodo" valor={t.registrados} detalle={soles(t.registradosMonto)} />
        <Dato
          titulo="Registrado por"
          valor={`${t.porCierre.ASESOR ?? 0} asesora · ${t.porCierre.IA ?? 0} IA`}
          detalle={t.porCierre["SIN DATO"] ? `${t.porCierre["SIN DATO"]} sin dato (Shopify o sin marcar)` : undefined}
        />
        <Dato titulo="Confirmados en el periodo" valor={t.confirmados} />
        <Dato titulo="Entregados en el periodo" valor={t.entregados} detalle={soles(t.entregadosMonto)} />
      </div>

      {Object.keys(t.noVentas).length > 0 && (
        <p className="text-xs text-neutral-500">
          No cuentan en estos números (salen del almacén, pero no son venta):{" "}
          {Object.entries(t.noVentas)
            .map(([tipo, n]) => `${n} ${tipo === "CAMBIO" ? "cambio(s)" : "reposición(es)"}`)
            .join(" · ")}
          .
        </p>
      )}

      {estados.length > 0 && (
        <section className={TARJETA}>
          <h3 className="font-semibold">Cómo están hoy los {registradosDelRango} registrados del periodo</h3>
          <div className="mt-2 flex flex-wrap gap-2 text-sm">
            {estados.map(([estado, v]) => (
              <span key={estado} className="rounded-lg bg-neutral-100 px-2.5 py-1 dark:bg-white/10">
                {estado} <b>{v.n}</b> ({conversion(v.n, registradosDelRango)}) · {soles(v.monto)}
              </span>
            ))}
          </div>
        </section>
      )}

      <section className={`${TARJETA} overflow-x-auto p-0`}>
        <div className="flex flex-wrap items-center justify-between gap-2 p-3">
          <h3 className="font-semibold">Día por día</h3>
          <div className="flex items-center gap-2 text-xs text-neutral-500">
            {ultimaFlujos ? `Flujos actualizado: ${new Date(ultimaFlujos).toLocaleString("es-PE", { timeZone: "America/Lima" })}` : "Flujos: sin datos todavía"}
            <button type="button" disabled={actualizando} onClick={onActualizarFlujos} className={`${BOTON_SECUNDARIO} h-8`}>
              <RefreshCw className={`size-3.5 ${actualizando ? "animate-spin" : ""}`} /> Actualizar Flujos
            </button>
          </div>
        </div>
        <table className="w-full min-w-[980px] text-sm">
          <thead className="text-left text-xs text-neutral-500">
            <tr className="border-y border-neutral-200 dark:border-white/10">
              <th className="p-3">Día</th>
              <th className="p-3 text-right">Leads Flujos</th>
              <th className="p-3 text-right">Ventas Flujos (IA)</th>
              <th className="p-3 text-right">Ventas IA en CRM (programadas / llegaron)</th>
              <th className="p-3 text-right">Registrados CRM</th>
              <th className="p-3 text-right">Leads → CRM</th>
              <th className="p-3 text-right">Por asesora / IA</th>
              <th className="p-3 text-right">Confirmados</th>
              <th className="p-3 text-right">Entregados</th>
            </tr>
          </thead>
          <tbody>
            {empresa.dias.map((d) => {
              const deWhatsapp = (d.por_canal["WASAP IA"] ?? 0) + (d.por_canal["WASAP EMP"] ?? 0);
              return (
                <tr key={d.dia} className="border-b border-neutral-100 last:border-0 dark:border-white/5">
                  <td className="p-3 font-medium">{d.dia}</td>
                  <td className="p-3 text-right tabular-nums">{d.flujos ? d.flujos.leads : "—"}</td>
                  <td className="p-3 text-right tabular-nums">{d.flujos ? `${d.flujos.ventas} (${d.flujos.ventas_ia})` : "—"}</td>
                  <td className="p-3 text-right tabular-nums">
                    {d.ia_programadas} / {d.ia_llegaron}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {d.registrados} <span className="text-xs text-neutral-500">{soles(d.registrados_monto)}</span>
                  </td>
                  <td className="p-3 text-right tabular-nums" title="Registrados de WhatsApp (WASAP IA + WASAP EMP) sobre leads de Flujos">
                    {d.flujos ? conversion(deWhatsapp, d.flujos.leads) : "—"}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {d.por_cierre.ASESOR ?? 0} / {d.por_cierre.IA ?? 0}
                  </td>
                  <td className="p-3 text-right tabular-nums">{d.confirmados}</td>
                  <td className="p-3 text-right tabular-nums">
                    {d.entregados} <span className="text-xs text-neutral-500">{soles(d.entregados_monto)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!conFlujos && (
          <p className="p-3 text-xs text-neutral-500">
            Los leads de Flujos se cuentan solos cada hora cuando la conexión con Flujos funciona (Configuración → Conexiones).
          </p>
        )}
      </section>

      {anuncios.length > 0 && (
        <section className={TARJETA}>
          <h3 className="font-semibold">Leads por anuncio en el periodo</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {anuncios.slice(0, 10).map(([titulo, n]) => (
              <li key={titulo} className="flex justify-between gap-3">
                <span className="truncate">{titulo}</span>
                <b className="tabular-nums">{n}</b>
              </li>
            ))}
          </ul>
        </section>
      )}

      {asesoras.length > 0 && (
        <p className="text-xs text-neutral-500">El detalle por asesora está en la pestaña Asesoras.</p>
      )}
    </div>
  );
}
