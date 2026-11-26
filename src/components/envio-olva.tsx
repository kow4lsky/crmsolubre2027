"use client";

import JSZip from "jszip";
import { Download } from "lucide-react";
import { useMemo, useState } from "react";

import { BOTON_SECUNDARIO } from "@/components/pedidos-ui";
import { INPUT_CLASS, Modal, PRIMARY_BUTTON_CLASS } from "@/components/ui";
import { etiquetaDeTienda, llenarHojaOlva, partirNombre, problemasDeFilaOlva, sugerirTiendaOlva, type FilaOlva } from "@/lib/envios-masivos";
import type { Pedido } from "@/lib/pedidos";
import { TIENDAS_OLVA, type TiendaOlva } from "@/lib/tiendas-olva";

const MEMORIA = "crm-solubre:tiendas-olva";
const claveDeTienda = (t: TiendaOlva) => `${t.departamento}|${t.provincia}|${t.distrito}|${t.tienda}`;
const POR_CLAVE = new Map(TIENDAS_OLVA.map((t) => [claveDeTienda(t), t]));
const ORDENADAS = [...TIENDAS_OLVA].sort((a, b) => etiquetaDeTienda(a).localeCompare(etiquetaDeTienda(b)));

function leerMemoria(): Record<string, string> {
  try {
    return JSON.parse(window.localStorage.getItem(MEMORIA) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

const claveDe = (p: Pedido) => `${p.direccion ?? ""} ${p.distrito ?? ""} ${p.provincia ?? ""}`.trim().toUpperCase();

type Fila = FilaOlva & { pedido: Pedido; segura: boolean; candidatas: TiendaOlva[] };

/**
 * "Archivo para Olva": los pedidos elegidos → la plantilla de envíos masivos
 * de Olva (pago en destino: el cliente paga su envío al recoger), entrega en
 * tienda o agente, Paquete S, artículos de limpieza, S/ 50 y sin seguro.
 */
export function EnvioOlva({ pedidos, onClose, onNotice }: { pedidos: Pedido[]; onClose: () => void; onNotice: (mensaje: string) => void }) {
  const deOlva = useMemo(() => pedidos.filter((p) => (p.courier ?? "").toUpperCase().includes("OLVA")), [pedidos]);
  const otros = pedidos.length - deOlva.length;

  const [filas, setFilas] = useState<Fila[]>(() => {
    const memoria = typeof window === "undefined" ? {} : leerMemoria();
    return deOlva.map((p) => {
      const recordada = POR_CLAVE.get(memoria[claveDe(p)] ?? "");
      const sugerencia = sugerirTiendaOlva(claveDe(p), TIENDAS_OLVA);
      const { nombres, apellido } = partirNombre(p.cliente ?? "");
      return {
        pedido: p,
        documento: (p.dni ?? "").replace(/\D/g, ""),
        nombres,
        apellido,
        telefono: (p.celular ?? "").replace(/\D/g, "").slice(-9),
        tienda: recordada ?? sugerencia.tienda,
        segura: !!recordada || sugerencia.segura,
        candidatas: sugerencia.candidatas,
      };
    });
  });
  const [generando, setGenerando] = useState(false);

  const cambiar = (i: number, cambio: Partial<Fila>) => setFilas((actual) => actual.map((f, j) => (j === i ? { ...f, ...cambio } : f)));
  const problemas = filas.map(problemasDeFilaOlva);
  const conProblemas = problemas.filter((p) => p.length > 0).length;

  const descargarArchivo = async () => {
    setGenerando(true);
    try {
      try {
        const memoria = leerMemoria();
        for (const f of filas) if (f.tienda) memoria[claveDe(f.pedido)] = claveDeTienda(f.tienda);
        window.localStorage.setItem(MEMORIA, JSON.stringify(memoria));
      } catch {
        // Sin almacenamiento igual funciona: sólo no se recuerda.
      }
      const respuesta = await fetch("/plantillas/olva-masivo.xlsm");
      if (!respuesta.ok) throw new Error("No encontré la plantilla de Olva.");
      const zip = await JSZip.loadAsync(await respuesta.arrayBuffer());
      const ruta = "xl/worksheets/sheet1.xml";
      const hoja = await zip.file(ruta)?.async("string");
      if (!hoja) throw new Error("La plantilla de Olva no tiene la hoja de envíos.");
      zip.file(ruta, llenarHojaOlva(hoja, filas));
      const archivo = await zip.generateAsync({ type: "blob", compression: "DEFLATE", mimeType: "application/vnd.ms-excel.sheet.macroEnabled.12" });
      const url = URL.createObjectURL(archivo);
      const enlace = document.createElement("a");
      enlace.href = url;
      enlace.download = `Olva_masivo_${new Date().toISOString().slice(0, 10)}.xlsm`;
      document.body.appendChild(enlace);
      enlace.click();
      enlace.remove();
      URL.revokeObjectURL(url);
      onNotice(`Listo: ${filas.length} envíos en el archivo para Olva.`);
    } catch (falla) {
      onNotice(falla instanceof Error ? falla.message : "No se pudo armar el archivo.");
    } finally {
      setGenerando(false);
    }
  };

  return (
    <Modal title="Archivo para Olva (envíos masivos, paga el cliente)" onClose={onClose} ancho="max-w-6xl">
      <div className="mt-3 space-y-3 text-sm">
        <p className="text-neutral-600 dark:text-neutral-300">
          Revisa la <b>tienda Olva de destino</b>, el nombre y el apellido de cada envío. Las amarillas las adivinó el CRM por la dirección:
          confírmalas. Lo que elijas se recuerda para la próxima vez.
          {otros > 0 && (
            <>
              {" "}
              <b>{otros}</b> de los seleccionados no son de Olva y no entran.
            </>
          )}
        </p>
        <div className="max-h-[60vh] overflow-auto rounded-xl border border-neutral-200 dark:border-white/10">
          <table className="w-full min-w-[1040px] text-xs">
            <thead className="sticky top-0 bg-neutral-50 text-left text-neutral-500 dark:bg-neutral-900">
              <tr>
                <th className="p-2">Pedido</th>
                <th className="p-2">Dirección del cliente</th>
                <th className="p-2">Tienda Olva de destino</th>
                <th className="p-2">Nombres</th>
                <th className="p-2">Apellido paterno</th>
                <th className="p-2">DNI</th>
                <th className="p-2">Celular</th>
              </tr>
            </thead>
            <tbody>
              {filas.map((f, i) => {
                const falta = problemas[i];
                const dudosa = !!f.tienda && !f.segura;
                return (
                  <tr key={f.pedido.id} className="border-t border-neutral-100 align-top dark:border-white/5">
                    <td className="p-2">
                      <b>{f.pedido.codigo}</b>
                      <span className="block">{f.pedido.cliente}</span>
                      <span className="block text-neutral-500">{f.pedido.pedido}</span>
                      {falta.length > 0 && <span className="mt-1 block font-semibold text-red-700 dark:text-red-300">Falta: {falta.join(", ")}</span>}
                    </td>
                    <td className="max-w-56 p-2">
                      {f.pedido.direccion || "—"}
                      <span className="block text-neutral-500">{[f.pedido.distrito, f.pedido.provincia].filter(Boolean).join(" / ")}</span>
                    </td>
                    <td className="w-72 p-2">
                      <select
                        value={f.tienda ? claveDeTienda(f.tienda) : ""}
                        onChange={(e) => cambiar(i, { tienda: POR_CLAVE.get(e.target.value) ?? null, segura: true })}
                        className={`${INPUT_CLASS} h-9 text-xs ${!f.tienda ? "border-red-400!" : dudosa ? "border-amber-400! bg-amber-50! dark:bg-amber-400/10!" : ""}`}
                      >
                        <option value="">Elige la tienda…</option>
                        {ORDENADAS.map((t) => (
                          <option key={claveDeTienda(t)} value={claveDeTienda(t)}>
                            {etiquetaDeTienda(t)}
                          </option>
                        ))}
                      </select>
                      {(!f.segura || !f.tienda) && f.candidatas.length > 0 && (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {f.candidatas.slice(0, 3).map((c) => (
                            <button
                              key={claveDeTienda(c)}
                              type="button"
                              onClick={() => cambiar(i, { tienda: c, segura: true })}
                              className="cursor-pointer rounded bg-neutral-100 px-1.5 py-0.5 text-left hover:bg-amber-100 dark:bg-white/10"
                            >
                              {etiquetaDeTienda(c)}
                            </button>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="w-32 p-2">
                      <input value={f.nombres} onChange={(e) => cambiar(i, { nombres: e.target.value })} className={`${INPUT_CLASS} h-9 text-xs`} />
                    </td>
                    <td className="w-28 p-2">
                      <input value={f.apellido} onChange={(e) => cambiar(i, { apellido: e.target.value })} className={`${INPUT_CLASS} h-9 text-xs`} />
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
          En el archivo van: entrega en tienda, Paquete S, artículos de limpieza, valor S/ 50 y sin seguro. El envío lo paga el cliente al recoger.
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
