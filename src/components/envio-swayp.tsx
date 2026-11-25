"use client";

import { Download, Send } from "lucide-react";
import { useMemo, useState } from "react";

import { registrarPedidosEnSwayp } from "@/app/actions";
import { BOTON_SECUNDARIO } from "@/components/pedidos-ui";
import { Modal, PRIMARY_BUTTON_CLASS } from "@/components/ui";
import { DISTRITOS_LIMA } from "@/lib/distritos-lima";
import { crearXlsx } from "@/lib/escribir-xlsx";
import { dayKeyInZone } from "@/lib/fechas";
import type { Pedido } from "@/lib/pedidos";
import { filaSwaypDesdePedido, filasExcelSwayp, problemasDeFilaSwayp, type FilaSwayp, type ServicioSwayp } from "@/lib/swayp-envios";
import type { ResultadoSwayp } from "@/lib/swayp-server";

const CELDA = "w-full rounded-lg border border-[#ddd8c9] bg-white px-2 py-1 text-xs dark:border-white/10 dark:bg-white/5";

/**
 * Pedidos de Lima → Swayp. Se revisan (distrito, monto a cobrar, servicio) y
 * se registran directo con la API, o se baja el Excel de carga masiva de
 * siempre para subirlo a mano.
 */
export function EnvioSwayp({
  pedidos,
  puedeRegistrar,
  onClose,
  onNotice,
  onRegistrado,
}: {
  pedidos: Pedido[];
  puedeRegistrar: boolean;
  onClose: () => void;
  onNotice: (mensaje: string) => void;
  onRegistrado?: () => void;
}) {
  const deSwayp = useMemo(
    () => pedidos.filter((p) => (p.courier ?? "").toUpperCase().includes("SWAYP") || (p.inventario ?? "").toUpperCase() === "SWAYP"),
    [pedidos],
  );
  const conGuia = deSwayp.filter((p) => p.guia_swayp);
  const otros = pedidos.length - deSwayp.length;
  const [filas, setFilas] = useState<FilaSwayp[]>(() => {
    const hoy = dayKeyInZone(new Date(), "America/Lima");
    return deSwayp.filter((p) => !p.guia_swayp).map((p) => filaSwaypDesdePedido(p, hoy));
  });
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultado, setResultado] = useState<ResultadoSwayp | null>(null);

  const cambiar = (i: number, cambios: Partial<FilaSwayp>) => setFilas((fs) => fs.map((f, j) => (j === i ? { ...f, ...cambios } : f)));
  const conProblemas = filas.filter((f) => problemasDeFilaSwayp(f).length).length;

  const descargar = async () => {
    const archivo = await crearXlsx(filasExcelSwayp(filas));
    const url = URL.createObjectURL(new Blob([archivo as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const enlace = document.createElement("a");
    enlace.href = url;
    const hoy = new Date().toLocaleDateString("es-PE", { day: "2-digit", month: "short", timeZone: "America/Lima" }).replace(/\.|\s/g, "_").toUpperCase();
    enlace.download = `SWAYP_${hoy}.xlsx`;
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    URL.revokeObjectURL(url);
    onNotice(`Excel para Swayp listo (${filas.length} pedidos).`);
  };

  const registrar = async () => {
    setOcupado(true);
    setError(null);
    const r = await registrarPedidosEnSwayp(filas);
    setOcupado(false);
    if (!r.ok) return setError(r.error);
    setResultado(r.resultado);
    if (r.resultado.registrados.length) {
      onNotice(`Swayp: ${r.resultado.registrados.length} guía(s) creadas.`);
      onRegistrado?.();
    }
  };

  return (
    <Modal title="Enviar a Swayp" onClose={onClose} ancho="max-w-6xl">
      <div className="mt-3 space-y-3 text-sm">
        {(otros > 0 || conGuia.length > 0) && (
          <p className="rounded-xl bg-[#f3f1ea] px-3 py-2 text-xs dark:bg-white/5">
            {otros > 0 && `${otros} pedido(s) no son de Swayp y no se incluyen. `}
            {conGuia.length > 0 && `${conGuia.length} ya tienen guía de Swayp (${conGuia.map((p) => p.codigo).join(", ")}).`}
          </p>
        )}

        {resultado ? (
          <div className="space-y-3">
            {resultado.registrados.length > 0 && (
              <div className="rounded-xl bg-emerald-50 p-3 dark:bg-emerald-500/10">
                <p className="font-semibold text-emerald-900 dark:text-emerald-200">Guías creadas ({resultado.registrados.length})</p>
                <ul className="mt-1 text-xs">
                  {resultado.registrados.map((r) => (
                    <li key={r.codigo}>
                      {r.codigo} → guía <b className="font-mono">{r.guia}</b>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {resultado.conError.length > 0 && (
              <div className="rounded-xl bg-red-50 p-3 dark:bg-red-500/10">
                <p className="font-semibold text-red-900 dark:text-red-200">No se registraron ({resultado.conError.length})</p>
                <ul className="mt-1 text-xs">
                  {resultado.conError.map((r) => (
                    <li key={r.codigo}>
                      {r.codigo}: {r.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex justify-end">
              <button type="button" onClick={onClose} className={PRIMARY_BUTTON_CLASS}>
                Listo
              </button>
            </div>
          </div>
        ) : filas.length === 0 ? (
          <p className="text-neutral-500">No hay pedidos de Swayp sin guía entre los seleccionados.</p>
        ) : (
          <>
            <div className="max-h-[55vh] overflow-auto">
              <table className="w-full min-w-[1080px]">
                <thead className="sticky top-0 bg-[#fbfaf6] dark:bg-neutral-900">
                  <tr className="text-left text-[11px] uppercase tracking-wide text-neutral-500">
                    <th className="px-1 py-2">Cod</th>
                    <th className="px-1 py-2">Cliente</th>
                    <th className="px-1 py-2">Celular</th>
                    <th className="px-1 py-2">Distrito</th>
                    <th className="px-1 py-2">Dirección</th>
                    <th className="px-1 py-2">Cobrar (S/)</th>
                    <th className="px-1 py-2">Contenido</th>
                    <th className="px-1 py-2">Servicio</th>
                    <th className="px-1 py-2">Fecha</th>
                    <th className="px-1 py-2">Observaciones</th>
                  </tr>
                </thead>
                <tbody>
                  {filas.map((f, i) => {
                    const faltan = problemasDeFilaSwayp(f);
                    return (
                      <tr key={f.pedidoId} className={`border-t border-[#efece2] align-top dark:border-white/5 ${faltan.length ? "bg-red-50/60 dark:bg-red-500/5" : ""}`}>
                        <td className="px-1 py-1.5 font-mono text-xs">
                          {f.codigo}
                          {faltan.length > 0 && <span className="block text-[10px] text-red-700 dark:text-red-300">Falta: {faltan.join(", ")}</span>}
                        </td>
                        <td className="px-1 py-1.5">
                          <input value={f.nombre} onChange={(e) => cambiar(i, { nombre: e.target.value })} className={CELDA} />
                        </td>
                        <td className="px-1 py-1.5">
                          <input value={f.telefono} onChange={(e) => cambiar(i, { telefono: e.target.value.replace(/\D/g, "") })} className={`${CELDA} w-24`} />
                        </td>
                        <td className="px-1 py-1.5">
                          <select
                            value={f.distrito}
                            onChange={(e) => cambiar(i, { distrito: e.target.value, distritoSeguro: true })}
                            className={`${CELDA} ${f.distrito && !f.distritoSeguro ? "border-amber-400! bg-amber-50! dark:bg-amber-400/10!" : ""}`}
                            title={f.distrito && !f.distritoSeguro ? "Adivinado de la dirección: revísalo" : undefined}
                          >
                            <option value="">Elige…</option>
                            {DISTRITOS_LIMA.map((d) => (
                              <option key={d.ubigeo} value={d.nombre}>
                                {d.nombre}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-1 py-1.5">
                          <textarea value={f.direccion} onChange={(e) => cambiar(i, { direccion: e.target.value })} rows={2} className={`${CELDA} min-w-48`} />
                          <input
                            value={f.adicional}
                            onChange={(e) => cambiar(i, { adicional: e.target.value })}
                            placeholder="Referencia (opcional)"
                            className={`${CELDA} mt-1`}
                          />
                        </td>
                        <td className="px-1 py-1.5">
                          <input
                            value={String(f.recaudo)}
                            inputMode="decimal"
                            onChange={(e) => cambiar(i, { recaudo: Math.max(0, Number(e.target.value.replace(",", ".")) || 0) })}
                            className={`${CELDA} w-20 text-right`}
                          />
                        </td>
                        <td className="px-1 py-1.5">
                          <textarea value={f.contenido} onChange={(e) => cambiar(i, { contenido: e.target.value })} rows={2} className={`${CELDA} min-w-40`} />
                        </td>
                        <td className="px-1 py-1.5">
                          <select value={f.servicio} onChange={(e) => cambiar(i, { servicio: e.target.value as ServicioSwayp })} className={CELDA}>
                            <option value="EXPRESS">Express</option>
                            <option value="NORMAL">Prog. normal</option>
                          </select>
                        </td>
                        <td className="px-1 py-1.5">
                          <input type="date" value={f.fecha} onChange={(e) => cambiar(i, { fecha: e.target.value })} className={CELDA} />
                        </td>
                        <td className="px-1 py-1.5">
                          <textarea value={f.observaciones} onChange={(e) => cambiar(i, { observaciones: e.target.value })} rows={2} className={`${CELDA} min-w-36`} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-neutral-500">
              El distrito en amarillo se adivinó de la dirección: revísalo. &quot;Cobrar&quot; es el monto menos el adelanto. Lo que cambies
              aquí sólo va a Swayp: el pedido del CRM no se modifica.
            </p>
            {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-500/10 dark:text-red-200">{error}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" onClick={() => void descargar()} className={BOTON_SECUNDARIO}>
                <Download className="size-4" /> Descargar Excel para Swayp
              </button>
              {puedeRegistrar && (
                <button
                  type="button"
                  disabled={ocupado || conProblemas > 0}
                  onClick={() => void registrar()}
                  className={PRIMARY_BUTTON_CLASS}
                  title={conProblemas ? "Corrige las filas en rojo primero" : undefined}
                >
                  <Send className="size-4" /> {ocupado ? "Registrando…" : `Registrar en Swayp (${filas.length})`}
                </button>
              )}
            </div>
            {puedeRegistrar && <p className="text-right text-xs text-neutral-500">Registrar crea las guías en Swayp y anota el número de guía en cada pedido.</p>}
          </>
        )}
      </div>
    </Modal>
  );
}
