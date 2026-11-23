"use client";

import { Download, FileSpreadsheet } from "lucide-react";
import { useState } from "react";

import { BOTON_SECUNDARIO, descargar } from "@/components/pedidos-ui";
import { INPUT_CLASS, Modal, PRIMARY_BUTTON_CLASS } from "@/components/ui";
import { leerCsv } from "@/lib/importar";
import { aCsvExcel } from "@/lib/pedidos";
import { TANDA_DE_IMPORTACION, leerPedidos, type LecturaDePedidos } from "@/lib/importar-pedidos";
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

  const analizar = async () => {
    if (!archivo) return;
    setError(null);
    setLectura(null);
    try {
      const texto = await archivo.text();
      const resultado = leerPedidos(leerCsv(texto), desde || null);
      if (resultado.error) setError(resultado.error);
      else setLectura(resultado);
    } catch {
      setError("No pude leer el archivo. Tiene que ser un CSV descargado de Google Sheets.");
    }
  };

  const importar = async () => {
    if (!lectura) return;
    setError(null);
    const total = lectura.filas.length;
    setAvance({ hechos: 0, total });
    for (let i = 0; i < total; i += TANDA_DE_IMPORTACION) {
      const tanda = lectura.filas.slice(i, i + TANDA_DE_IMPORTACION);
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
            <b>{lectura.filas.length.toLocaleString("es-PE")}</b> pedidos listos para importar.
          </p>
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
            <li>• Si un código ya existe en el CRM, se actualiza con lo de la planilla.</li>
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
                <button type="button" disabled={!!avance || lectura.filas.length === 0} onClick={importar} className={PRIMARY_BUTTON_CLASS}>
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
