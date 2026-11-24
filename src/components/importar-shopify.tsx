"use client";

import { Download, FileSpreadsheet } from "lucide-react";
import { useState } from "react";

import { BOTON_SECUNDARIO, descargar } from "@/components/pedidos-ui";
import { INPUT_CLASS, Modal, PRIMARY_BUTTON_CLASS } from "@/components/ui";
import { leerCsv } from "@/lib/importar";
import { type Existente } from "@/lib/importar-pedidos";
import { leerBaseShopify, numerosYaAtendidos, pedidoDesdeBaseShopify, type PedidoDeShopify } from "@/lib/importar-shopify";
import { OPCIONES, aCsvExcel, fechaYHoraDeLima } from "@/lib/pedidos";
import { getSupabaseBrowser } from "@/lib/supabase/browser";

type Revisado = PedidoDeShopify & { mismoCelular: Existente[] };

/**
 * Sube de golpe los pedidos de Shopify que quedaron sin atender en el CRM
 * anterior (pestaña BASE_SHOPIFY). Cada uno entra como pedido nuevo, con su
 * código WED, en VOLVER A LLAMAR. Los que ya se atendieron no entran.
 */
export function ImportarShopify({
  workspaceId,
  onClose,
  onTerminado,
}: {
  workspaceId: string;
  onClose: () => void;
  onTerminado: (mensaje: string) => void;
}) {
  const supabase = getSupabaseBrowser();
  const [archivo, setArchivo] = useState<File | null>(null);
  const [desde, setDesde] = useState("");
  const [asesor, setAsesor] = useState("YAHAIRA");
  const [revisando, setRevisando] = useState(false);
  const [revisados, setRevisados] = useState<Revisado[] | null>(null);
  const [atendidos, setAtendidos] = useState(0);
  const [aviso, setAviso] = useState<string[]>([]);
  const [elegidos, setElegidos] = useState<Set<string>>(new Set());
  const [avance, setAvance] = useState<{ hechos: number; total: number } | null>(null);
  const [creados, setCreados] = useState<{ origen: string; codigo: string; cliente: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Todos los pedidos del CRM que pueden venir de Shopify, de a páginas. */
  const traerDeShopifyEnElCrm = async () => {
    const todos: { nota: string | null; extra: Record<string, unknown> | null }[] = [];
    for (let desdeFila = 0; ; desdeFila += 1000) {
      const { data, error: falla } = await supabase
        .from("pedidos")
        .select("nota, extra")
        .eq("workspace_id", workspaceId)
        .or('nota.ilike."%Origen Shopify%",canal.eq.SHOPIFY')
        .order("id")
        .range(desdeFila, desdeFila + 999);
      if (falla) throw new Error(falla.message);
      todos.push(...((data ?? []) as typeof todos));
      if (!data || data.length < 1000) return todos;
    }
  };

  const analizar = async () => {
    if (!archivo) return;
    setError(null);
    setRevisando(true);
    try {
      const lectura = leerBaseShopify(leerCsv(await archivo.text()), desde || null);
      if (lectura.error) throw new Error(lectura.error);

      const yaAtendidos = numerosYaAtendidos(await traerDeShopifyEnElCrm());
      const pendientes = lectura.pedidos.filter((p) => !yaAtendidos.has(p.origen));

      // De los que faltan, cuáles tienen un celular que ya está en el CRM.
      const celulares = [...new Set(pendientes.map((p) => p.celular).filter((c): c is string => !!c))];
      const porCelular = new Map<string, Existente[]>();
      for (let i = 0; i < celulares.length; i += 200) {
        const { data, error: falla } = await supabase
          .from("pedidos")
          .select("codigo, cliente, celular, fecha_registro, estado, monto")
          .eq("workspace_id", workspaceId)
          .in("celular", celulares.slice(i, i + 200));
        if (falla) throw new Error(falla.message);
        for (const e of (data ?? []) as Existente[]) {
          if (e.celular) porCelular.set(e.celular, [...(porCelular.get(e.celular) ?? []), e]);
        }
      }

      const lista = pendientes
        .map((p) => ({ ...p, mismoCelular: p.celular ? (porCelular.get(p.celular) ?? []) : [] }))
        .sort((a, b) => (a.fecha ?? "").localeCompare(b.fecha ?? ""));
      setRevisados(lista);
      setAtendidos(lectura.pedidos.length - pendientes.length);
      setAviso([
        ...(lectura.fueraDeRango ? [`${lectura.fueraDeRango.toLocaleString("es-PE")} quedan afuera por la fecha.`] : []),
        ...(lectura.repetidos ? [`${lectura.repetidos} números de Shopify aparecen dos veces: se usa la primera fila.`] : []),
      ]);
      // Los que no se parecen a nada entran marcados; los de celular conocido, no.
      setElegidos(new Set(lista.filter((p) => p.mismoCelular.length === 0).map((p) => p.origen)));
    } catch (falla) {
      setError(falla instanceof Error ? falla.message : "No pude leer el archivo. Tiene que ser un CSV descargado de Google Sheets.");
    } finally {
      setRevisando(false);
    }
  };

  const importar = async () => {
    if (!revisados) return;
    setError(null);
    const { data: productos } = await supabase.from("productos").select("nombre").eq("workspace_id", workspaceId);
    const catalogo = ((productos ?? []) as { nombre: string }[]).map((p) => p.nombre);
    // Del más viejo al más nuevo: así los códigos WED quedan en el mismo orden.
    const aSubir = revisados.filter((p) => elegidos.has(p.origen));
    const hechos: { origen: string; codigo: string; cliente: string }[] = [];
    setAvance({ hechos: 0, total: aSubir.length });
    for (const p of aSubir) {
      const { fila, items } = pedidoDesdeBaseShopify(p, { asesor, catalogo, ahora: new Date() });
      const { data, error: falla } = await supabase
        .from("pedidos")
        .insert({ ...fila, workspace_id: workspaceId, codigo: "" })
        .select("id, codigo")
        .single();
      if (falla || !data) {
        setError(
          `Se cortó en el pedido de Shopify #${p.origen}: ${falla?.message ?? "sin respuesta"}. Los ${hechos.length} anteriores ya entraron; ` +
            "si vuelves a analizar el archivo, ya no aparecen.",
        );
        setCreados(hechos);
        setAvance(null);
        return;
      }
      if (items.length) {
        await supabase.from("pedido_items").insert(items.map((i) => ({ ...i, pedido_id: data.id, workspace_id: workspaceId })));
      }
      hechos.push({ origen: p.origen, codigo: data.codigo as string, cliente: p.cliente });
      setAvance({ hechos: hechos.length, total: aSubir.length });
    }
    setCreados(hechos);
    setAvance(null);
    onTerminado(`Listo: ${hechos.length} pedidos de Shopify entraron en VOLVER A LLAMAR para ${asesor}.`);
  };

  const alternar = (origen: string) =>
    setElegidos((actual) => {
      const nueva = new Set(actual);
      if (nueva.has(origen)) nueva.delete(origen);
      else nueva.add(origen);
      return nueva;
    });

  return (
    <Modal title="Shopify pendientes del CRM anterior" onClose={onClose} ancho="max-w-2xl">
      {!revisados && (
        <div className="mt-4 space-y-4 text-sm">
          <ol className="list-decimal space-y-1 pl-5 text-neutral-600 dark:text-neutral-300">
            <li>
              Abre tu Google Sheet y ve a la pestaña <b>BASE_SHOPIFY</b>.
            </li>
            <li>
              Menú <b>Archivo → Descargar → Valores separados por comas (.csv)</b>.
            </li>
            <li>Elige ese archivo acá abajo. Tu planilla no se modifica.</li>
          </ol>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => setArchivo(e.target.files?.[0] ?? null)}
            className="block w-full text-sm file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-amber-500 file:px-3 file:py-2 file:font-semibold file:text-neutral-950"
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                Sólo los pedidos desde (opcional)
              </span>
              <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className={INPUT_CLASS} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">Asesora que los recibe</span>
              <select value={asesor} onChange={(e) => setAsesor(e.target.value)} className={INPUT_CLASS}>
                {OPCIONES.asesor.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex justify-end">
            <button type="button" disabled={!archivo || revisando} onClick={analizar} className={PRIMARY_BUTTON_CLASS}>
              <FileSpreadsheet className="size-4" /> {revisando ? "Revisando…" : "Analizar archivo"}
            </button>
          </div>
        </div>
      )}

      {revisados && !creados && (
        <div className="mt-4 space-y-3 text-sm">
          <p className="rounded-xl bg-white p-3 text-base dark:bg-white/5">
            <b>{elegidos.size}</b> pedidos van a entrar en <b>VOLVER A LLAMAR</b> para <b>{asesor}</b>, cada uno con su código WED nuevo.
          </p>
          <ul className="space-y-1 text-neutral-600 dark:text-neutral-300">
            <li>
              • {atendidos.toLocaleString("es-PE")} ya se atendieron (ya tienen pedido en el CRM): <b>no entran</b>.
            </li>
            {aviso.map((a) => (
              <li key={a}>• {a}</li>
            ))}
            <li>
              • Los que tienen un <b>celular que ya está en el CRM</b> quedan sin marcar: revisa y marca los que sí son pedidos nuevos.
            </li>
          </ul>
          {revisados.length === 0 ? (
            <p className="rounded-xl bg-white p-3 dark:bg-white/5">No hay pedidos de Shopify sin atender.</p>
          ) : (
            <ul className="max-h-96 space-y-2 overflow-auto">
              {revisados.map((p) => (
                <li
                  key={p.origen}
                  className={`rounded-lg p-2 text-xs ${p.mismoCelular.length ? "border border-amber-300 bg-amber-50 dark:border-amber-400/30 dark:bg-amber-400/10" : "bg-white dark:bg-white/5"}`}
                >
                  <label className="flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      checked={elegidos.has(p.origen)}
                      onChange={() => alternar(p.origen)}
                      className="mt-0.5 size-4 accent-amber-500"
                    />
                    <span>
                      <b>#{p.origen}</b> · {p.fecha ? fechaYHoraDeLima(p.fecha) : "sin fecha"} · {p.cliente} · {p.celular ?? "sin celular"} ·{" "}
                      {p.cantidad}x {p.producto || "—"} · S/ {p.monto ?? 0} · {p.envio || "—"}
                      {p.mismoCelular.map((e) => (
                        <span key={e.codigo} className="mt-0.5 block text-neutral-600 dark:text-neutral-300">
                          Mismo celular en el CRM: {e.codigo} · {e.cliente} · {e.fecha_registro} · {e.estado}
                        </span>
                      ))}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}

          {avance && (
            <div>
              <div className="h-2.5 rounded-full bg-neutral-200 dark:bg-white/10">
                <div
                  className="h-2.5 rounded-full bg-amber-500 transition-all"
                  style={{ width: `${(avance.hechos / Math.max(1, avance.total)) * 100}%` }}
                />
              </div>
              <p className="mt-1 text-xs text-neutral-500">
                {avance.hechos} de {avance.total}
              </p>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" disabled={!!avance} onClick={() => setRevisados(null)} className={BOTON_SECUNDARIO}>
              Volver
            </button>
            <button type="button" disabled={!!avance || elegidos.size === 0} onClick={importar} className={PRIMARY_BUTTON_CLASS}>
              {avance ? "Creando pedidos…" : `Crear ${elegidos.size} pedidos`}
            </button>
          </div>
        </div>
      )}

      {creados && (
        <div className="mt-4 space-y-3 text-sm">
          <p className="rounded-xl bg-white p-3 text-base dark:bg-white/5">
            Entraron <b>{creados.length}</b> pedidos
            {creados.length > 0 && (
              <>
                : del <b>{creados[0].codigo}</b> al <b>{creados[creados.length - 1].codigo}</b>
              </>
            )}
            .
          </p>
          <div className="flex justify-end gap-2">
            {creados.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  descargar(
                    "shopify_importados.csv",
                    aCsvExcel([["SHOPIFY", "COD", "CLIENTE"], ...creados.map((c) => [`#${c.origen}`, c.codigo, c.cliente])]),
                  )
                }
                className={BOTON_SECUNDARIO}
              >
                <Download className="size-4" /> Bajar la lista
              </button>
            )}
            <button type="button" onClick={onClose} className={PRIMARY_BUTTON_CLASS}>
              Cerrar
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-500/10 dark:text-red-200">{error}</p>}
    </Modal>
  );
}
