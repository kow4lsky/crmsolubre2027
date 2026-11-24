"use client";

import JSZip from "jszip";
import { Download } from "lucide-react";
import { useMemo, useState } from "react";

import { BOTON_SECUNDARIO } from "@/components/pedidos-ui";
import { INPUT_CLASS, Modal, PRIMARY_BUTTON_CLASS } from "@/components/ui";
import { AGENCIAS_SHALOM } from "@/lib/agencias-shalom";
import {
  cajaShalom,
  llenarHojaShalom,
  problemasDeFilaShalom,
  productosPrincipales,
  sugerirAgencia,
  type CajaShalom,
  type FilaShalom,
} from "@/lib/envios-masivos";
import type { Pedido } from "@/lib/pedidos";

/** Lo que se eligió a mano para una dirección: la próxima vez se propone solo. */
const MEMORIA = "crm-solubre:agencias-shalom";

function leerMemoria(): Record<string, string> {
  try {
    return JSON.parse(window.localStorage.getItem(MEMORIA) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function guardarMemoria(memoria: Record<string, string>) {
  try {
    window.localStorage.setItem(MEMORIA, JSON.stringify(memoria));
  } catch {
    // Sin almacenamiento igual funciona: sólo no se recuerda.
  }
}

const claveDe = (p: Pedido) => `${p.direccion ?? ""} ${p.distrito ?? ""} ${p.provincia ?? ""}`.trim().toUpperCase();

type Fila = { pedido: Pedido; documento: string; telefono: string; destino: string; segura: boolean; candidatas: string[]; caja: CajaShalom; principales: number };

/**
 * "Archivo para Shalom": los pedidos elegidos → la plantilla de registro
 * masivo de Shalom, lista para subir en pro.shalom.pe.
 */
export function EnvioShalom({ pedidos, onClose, onNotice }: { pedidos: Pedido[]; onClose: () => void; onNotice: (mensaje: string) => void }) {
  const deShalom = useMemo(() => pedidos.filter((p) => (p.courier ?? "").toUpperCase().includes("SHALOM")), [pedidos]);
  const otros = pedidos.length - deShalom.length;

  const [filas, setFilas] = useState<Fila[]>(() => {
    const memoria = typeof window === "undefined" ? {} : leerMemoria();
    return deShalom.map((p) => {
      const recordada = memoria[claveDe(p)];
      const sugerencia = sugerirAgencia(claveDe(p), AGENCIAS_SHALOM);
      const principales = productosPrincipales(p.pedido ?? "");
      return {
        pedido: p,
        documento: (p.dni ?? "").replace(/\D/g, ""),
        telefono: (p.celular ?? "").replace(/\D/g, "").slice(-9),
        destino: recordada && AGENCIAS_SHALOM.includes(recordada) ? recordada : (sugerencia.agencia ?? ""),
        segura: !!recordada || sugerencia.segura,
        candidatas: sugerencia.candidatas,
        caja: cajaShalom(principales),
        principales,
      };
    });
  });
  const [generando, setGenerando] = useState(false);

  const cambiar = (i: number, cambio: Partial<Fila>) => setFilas((actual) => actual.map((f, j) => (j === i ? { ...f, ...cambio } : f)));

  const problemas = filas.map((f) => problemasDeFilaShalom(f, AGENCIAS_SHALOM));
  const conProblemas = problemas.filter((p) => p.length > 0).length;

  const descargarArchivo = async () => {
    setGenerando(true);
    try {
      // Lo elegido a mano se recuerda para la próxima.
      const memoria = leerMemoria();
      for (const f of filas) if (f.destino) memoria[claveDe(f.pedido)] = f.destino;
      guardarMemoria(memoria);

      const respuesta = await fetch("/plantillas/shalom-masivo.xlsx");
      if (!respuesta.ok) throw new Error("No encontré la plantilla de Shalom.");
      const zip = await JSZip.loadAsync(await respuesta.arrayBuffer());
      const ruta = "xl/worksheets/sheet1.xml";
      const hoja = await zip.file(ruta)?.async("string");
      if (!hoja) throw new Error("La plantilla de Shalom no tiene la hoja de envíos.");
      const datos: FilaShalom[] = filas.map((f) => ({ documento: f.documento, telefono: f.telefono, destino: f.destino, caja: f.caja }));
      zip.file(ruta, llenarHojaShalom(hoja, datos));
      const archivo = await zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(archivo);
      const enlace = document.createElement("a");
      enlace.href = url;
      enlace.download = `Shalom_masivo_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(enlace);
      enlace.click();
      enlace.remove();
      URL.revokeObjectURL(url);
      onNotice(`Listo: ${filas.length} envíos en el archivo para Shalom.`);
    } catch (falla) {
      onNotice(falla instanceof Error ? falla.message : "No se pudo armar el archivo.");
    } finally {
      setGenerando(false);
    }
  };

  return (
    <Modal title="Archivo para Shalom (registro masivo)" onClose={onClose} ancho="max-w-6xl">
      <div className="mt-3 space-y-3 text-sm">
        <p className="text-neutral-600 dark:text-neutral-300">
          Revisa la <b>agencia de destino</b> y la <b>caja</b> de cada envío. Las amarillas las adivinó el CRM por la dirección: confírmalas. Lo
          que elijas se recuerda para la próxima vez.
          {otros > 0 && (
            <>
              {" "}
              <b>{otros}</b> de los seleccionados no son de Shalom y no entran.
            </>
          )}
        </p>
        <datalist id="agencias-shalom">
          {AGENCIAS_SHALOM.map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
        <div className="max-h-[60vh] overflow-auto rounded-xl border border-neutral-200 dark:border-white/10">
          <table className="w-full min-w-[960px] text-xs">
            <thead className="sticky top-0 bg-neutral-50 text-left text-neutral-500 dark:bg-neutral-900">
              <tr>
                <th className="p-2">Pedido</th>
                <th className="p-2">Dirección del cliente</th>
                <th className="p-2">Agencia de destino</th>
                <th className="p-2">Caja</th>
                <th className="p-2">DNI</th>
                <th className="p-2">Celular</th>
              </tr>
            </thead>
            <tbody>
              {filas.map((f, i) => {
                const falta = problemas[i];
                const dudosa = !!f.destino && !f.segura;
                return (
                  <tr key={f.pedido.id} className="border-t border-neutral-100 align-top dark:border-white/5">
                    <td className="p-2">
                      <b>{f.pedido.codigo}</b>
                      <span className="block">{f.pedido.cliente}</span>
                      <span className="block text-neutral-500">{f.pedido.pedido}</span>
                      {falta.length > 0 && <span className="mt-1 block font-semibold text-red-700 dark:text-red-300">Falta: {falta.join(", ")}</span>}
                    </td>
                    <td className="max-w-64 p-2">
                      {f.pedido.direccion || "—"}
                      <span className="block text-neutral-500">{[f.pedido.distrito, f.pedido.provincia].filter(Boolean).join(" / ")}</span>
                    </td>
                    <td className="w-64 p-2">
                      <input
                        list="agencias-shalom"
                        value={f.destino}
                        onChange={(e) => cambiar(i, { destino: e.target.value.toUpperCase(), segura: true })}
                        placeholder="Escribe para buscar…"
                        className={`${INPUT_CLASS} h-9 text-xs ${!f.destino || !AGENCIAS_SHALOM.includes(f.destino) ? "border-red-400!" : dudosa ? "border-amber-400! bg-amber-50! dark:bg-amber-400/10!" : ""}`}
                      />
                      {(!f.segura || !f.destino) && f.candidatas.length > 0 && (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {f.candidatas.slice(0, 4).map((c) => (
                            <button
                              key={c}
                              type="button"
                              onClick={() => cambiar(i, { destino: c, segura: true })}
                              className="cursor-pointer rounded bg-neutral-100 px-1.5 py-0.5 hover:bg-amber-100 dark:bg-white/10"
                            >
                              {c}
                            </button>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="p-2">
                      <select value={f.caja} onChange={(e) => cambiar(i, { caja: e.target.value as CajaShalom })} className={`${INPUT_CLASS} h-9 text-xs`}>
                        <option value="PAQUETE S">PAQUETE S</option>
                        <option value="PAQUETE M">PAQUETE M</option>
                      </select>
                      <span className="mt-1 block text-neutral-500">{f.principales} principal(es)</span>
                    </td>
                    <td className="w-28 p-2">
                      <input value={f.documento} onChange={(e) => cambiar(i, { documento: e.target.value })} className={`${INPUT_CLASS} h-9 text-xs`} />
                    </td>
                    <td className="w-28 p-2">
                      <input value={f.telefono} onChange={(e) => cambiar(i, { telefono: e.target.value })} className={`${INPUT_CLASS} h-9 text-xs`} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-neutral-500">
          En el archivo van: origen AV JOSE LEAL CDRA 6, cantidad 1 y las medidas de cada caja. La clave y el &quot;No deseo&quot; de cobro seguro se
          confirman en Shalom al subirlo.
        </p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {conProblemas > 0 && <span className="mr-auto text-xs font-semibold text-red-700 dark:text-red-300">{conProblemas} envío(s) con datos por corregir</span>}
          <button type="button" onClick={onClose} className={BOTON_SECUNDARIO}>
            Cerrar
          </button>
          <button type="button" disabled={generando || filas.length === 0 || conProblemas > 0} onClick={descargarArchivo} className={PRIMARY_BUTTON_CLASS}>
            <Download className="size-4" /> {generando ? "Armando…" : `Descargar archivo (${filas.length})`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
