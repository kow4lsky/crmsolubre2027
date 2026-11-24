"use client";

import { Download, FileSpreadsheet } from "lucide-react";
import { useState } from "react";

import { BOTON_SECUNDARIO, descargar } from "@/components/pedidos-ui";
import { INPUT_CLASS, Modal, PRIMARY_BUTTON_CLASS } from "@/components/ui";
import { leerCsv } from "@/lib/importar";
import { aCsvExcel } from "@/lib/pedidos";
import {
  TANDA_DE_IMPORTACION,
  buscarCoincidencias,
  filasAImportar,
  leerPedidos,
  type Coincidencia,
  type Existente,
  type LecturaDePedidos,
} from "@/lib/importar-pedidos";
import { getSupabaseBrowser } from "@/lib/supabase/browser";

/**
 * Trae la pestaña "base" del Google Sheet. Sólo lee el archivo descargado: la
 * planilla original no se toca nunca.
 */
export function ImportarPedidos({
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
  const [lectura, setLectura] = useState<LecturaDePedidos | null>(null);
  const [avance, setAvance] = useState<{ hechos: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [terminado, setTerminado] = useState(false);
  // Las filas que ya se parecen a algo del CRM, y cuáles se importan igual.
  const [coincidencias, setCoincidencias] = useState<Coincidencia[] | null>(null);
  const [incluir, setIncluir] = useState<Set<string>>(new Set());

  /** Busca en el CRM los códigos y celulares del archivo, de a tandas. */
  const revisarRepetidos = async (resultado: LecturaDePedidos) => {
    const columnas = "codigo, cliente, celular, fecha_registro, estado, monto";
    const codigos = resultado.filas.map((f) => f.codigo);
    const celulares = [...new Set(resultado.filas.map((f) => f.celular).filter((c): c is string => typeof c === "string" && c.length > 0))];
    const existentes = new Map<string, Existente>();
    const traer = async (campo: "codigo" | "celular", valores: string[]) => {
      for (let i = 0; i < valores.length; i += 200) {
        const { data, error: falla } = await supabase
          .from("pedidos")
          .select(columnas)
          .eq("workspace_id", workspaceId)
          .in(campo, valores.slice(i, i + 200));
        if (falla) throw new Error(falla.message);
        for (const e of (data ?? []) as Existente[]) existentes.set(e.codigo, e);
      }
    };
    await traer("codigo", codigos);
    await traer("celular", celulares);
    setIncluir(new Set());
    setCoincidencias(buscarCoincidencias(resultado.filas, [...existentes.values()]));
  };

  const analizar = async () => {
    if (!archivo) return;
    setError(null);
    setLectura(null);
    try {
      const texto = await archivo.text();
      const resultado = leerPedidos(leerCsv(texto), desde || null);
      if (resultado.error) setError(resultado.error);
      else {
        setCoincidencias(null);
        setLectura(resultado);
        await revisarRepetidos(resultado);
      }
    } catch (falla) {
      setError(
        falla instanceof Error && !/JSON|CSV/.test(falla.message)
          ? `No pude revisar los repetidos: ${falla.message}`
          : "No pude leer el archivo. Tiene que ser un CSV descargado de Google Sheets.",
      );
    }
  };

  const importar = async () => {
    if (!lectura || !coincidencias) return;
    setError(null);
    const filas = filasAImportar(lectura.filas, coincidencias, incluir);
    const total = filas.length;
    setAvance({ hechos: 0, total });
    for (let i = 0; i < total; i += TANDA_DE_IMPORTACION) {
      const tanda = filas.slice(i, i + TANDA_DE_IMPORTACION);
      const { error: falla } = await supabase.rpc("importar_pedidos", { ws: workspaceId, filas: tanda });
      if (falla) {
        setError(`Se cortó en el pedido ${i + 1} de ${total}: ${falla.message}. Lo que ya entró quedó guardado; puedes volver a importar el mismo archivo y se completa.`);
        setAvance(null);
        return;
      }
      setAvance({ hechos: Math.min(total, i + tanda.length), total });
    }
    setTerminado(true);
    onTerminado(`Listo: ${total.toLocaleString("es-PE")} pedidos importados.`);
  };

  const desconocidos = lectura ? Object.entries(lectura.estadosDesconocidos) : [];

  return (
    <Modal title="Importar desde la planilla" onClose={onClose} ancho="max-w-2xl">
      {!lectura && (
        <div className="mt-4 space-y-4 text-sm">
          <ol className="list-decimal space-y-1 pl-5 text-neutral-600 dark:text-neutral-300">
            <li>Abre tu Google Sheet (o una copia) y ve a la pestaña <b>base</b>.</li>
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
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
              Sólo los registrados desde (opcional; vacío = todos)
            </span>
            <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className={INPUT_CLASS} />
          </label>
          <div className="flex justify-end">
            <button type="button" disabled={!archivo} onClick={analizar} className={PRIMARY_BUTTON_CLASS}>
              <FileSpreadsheet className="size-4" /> Analizar archivo
            </button>
          </div>
        </div>
      )}

      {lectura && (
        <div className="mt-4 space-y-3 text-sm">
          <p className="rounded-xl bg-white p-3 text-base dark:bg-white/5">
            {coincidencias ? (
              <>
                <b>{filasAImportar(lectura.filas, coincidencias, incluir).length.toLocaleString("es-PE")}</b> pedidos se van a
                importar{coincidencias.length > 0 && ` (de ${lectura.filas.length.toLocaleString("es-PE")} en el archivo)`}.
              </>
            ) : (
              <>Revisando qué ya está en el CRM…</>
            )}
          </p>
          {coincidencias && coincidencias.length > 0 && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-400/30 dark:bg-amber-400/10">
              <p className="font-semibold">
                {coincidencias.length} fila(s) se parecen a pedidos que ya están en el CRM
              </p>
              <p className="mt-0.5 text-xs text-neutral-600 dark:text-neutral-300">
                Por defecto <b>no se importan</b>. Marca las que sí quieres traer: una recompra del mismo cliente, por ejemplo.
                Si el código ya existe, importarla <b>reemplaza</b> al pedido del CRM.
              </p>
              <ul className="mt-2 max-h-72 space-y-2 overflow-auto">
                {coincidencias.map((c) => {
                  const f = c.fila;
                  const marcada = incluir.has(f.codigo);
                  return (
                    <li key={f.codigo} className="rounded-lg bg-white p-2 text-xs dark:bg-white/5">
                      <label className="flex cursor-pointer items-start gap-2">
                        <input
                          type="checkbox"
                          checked={marcada}
                          onChange={() =>
                            setIncluir((actual) => {
                              const nueva = new Set(actual);
                              if (nueva.has(f.codigo)) nueva.delete(f.codigo);
                              else nueva.add(f.codigo);
                              return nueva;
                            })
                          }
                          className="mt-0.5 size-4 accent-amber-500"
                        />
                        <span>
                          <b>Archivo:</b> {f.codigo} · {String(f.cliente ?? "—")} · {String(f.celular ?? "—")} ·{" "}
                          {String(f.fecha_registro ?? "")} · {String(f.estado ?? "")}
                          {c.porCodigo && (
                            <span className="mt-0.5 block text-red-700 dark:text-red-300">
                              Ese código ya existe: {c.porCodigo.cliente} · {c.porCodigo.fecha_registro} · {c.porCodigo.estado}. Importarla lo
                              reemplaza.
                            </span>
                          )}
                          {c.porCelular.map((e) => (
                            <span key={e.codigo} className="mt-0.5 block text-neutral-600 dark:text-neutral-300">
                              Mismo celular en el CRM: {e.codigo} · {e.cliente} · {e.fecha_registro} · {e.estado}
                            </span>
                          ))}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <ul className="space-y-1 text-neutral-600 dark:text-neutral-300">
            {lectura.fueraDeRango > 0 && <li>• {lectura.fueraDeRango.toLocaleString("es-PE")} quedan afuera por la fecha.</li>}
            {lectura.sinCodigo > 0 && <li>• {lectura.sinCodigo} filas sin COD: no se importan.</li>}
            {lectura.codigosRepetidos > 0 && (
              <li>
                • {lectura.codigosRepetidos} códigos aparecen en más de una fila ({lectura.detalleRepetidos.length} filas): <b>no se
                importan</b>. Quedan solo en tu Google Sheet.
              </li>
            )}
            {lectura.detalleRepetidos.length > 0 && (
              <li>
                <button
                  type="button"
                  onClick={() =>
                    descargar(
                      "codigos_repetidos.csv",
                      aCsvExcel([
                        ["COD", "CLIENTE", "CELULAR", "F.REG", "ESTADO", "MONTO", "ASESOR", "QUÉ HIZO EL CRM"],
                        ...lectura.detalleRepetidos.map((d) => [d.codigo, d.cliente, d.celular, d.fecha, d.estado, d.monto, d.asesor, d.decision]),
                      ]),
                    )
                  }
                  className="mt-1 inline-flex cursor-pointer items-center gap-1 font-semibold text-amber-700 hover:underline dark:text-amber-300"
                >
                  <Download className="size-4" /> Bajar lista de repetidos para revisarla
                </button>
              </li>
            )}
            {desconocidos.length > 0 && (
              <li>
                • Estados que no reconocí (entran como VOLVER A LLAMAR y el original se guarda):{" "}
                {desconocidos.map(([estado, n]) => `${estado} (${n})`).join(", ")}
              </li>
            )}
            {lectura.valoresRaros > 0 && (
              <li>
                • {lectura.valoresRaros} montos o cantidades que no parecían reales (por ejemplo, un celular en la columna MONTO): se
                guardan como &quot;otros datos&quot; del pedido en vez de como número.
              </li>
            )}
            <li>• Lo que coincide con el CRM sólo entra si lo marcas arriba. El resto entra como pedido nuevo.</li>
          </ul>
          <details className="rounded-xl bg-white p-3 dark:bg-white/5">
            <summary className="cursor-pointer font-semibold">Columnas reconocidas ({lectura.reconocidas.length})</summary>
            <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-300">{lectura.reconocidas.join(" · ")}</p>
          </details>
          {lectura.extras.length > 0 && (
            <details className="rounded-xl bg-white p-3 dark:bg-white/5">
              <summary className="cursor-pointer font-semibold">Se guardan como &quot;otros datos&quot; ({lectura.extras.length})</summary>
              <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-300">{lectura.extras.join(" · ")}</p>
            </details>
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
                {avance.hechos.toLocaleString("es-PE")} de {avance.total.toLocaleString("es-PE")}
              </p>
            </div>
          )}

          <div className="flex justify-end gap-2">
            {terminado ? (
              <button type="button" onClick={onClose} className={PRIMARY_BUTTON_CLASS}>
                Cerrar
              </button>
            ) : (
              <>
                <button type="button" disabled={!!avance} onClick={() => setLectura(null)} className={BOTON_SECUNDARIO}>
                  Volver
                </button>
                <button
                  type="button"
                  disabled={!!avance || !coincidencias || filasAImportar(lectura.filas, coincidencias, incluir).length === 0}
                  onClick={importar}
                  className={PRIMARY_BUTTON_CLASS}
                >
                  {avance ? "Importando…" : "Importar"}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {error && <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-500/10 dark:text-red-200">{error}</p>}
    </Modal>
  );
}
