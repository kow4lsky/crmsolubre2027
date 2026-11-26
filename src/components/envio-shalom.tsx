"use client";

import JSZip from "jszip";

import { registrarIndividualesEnShalom, registrarPedidosEnShalom } from "@/app/actions";
import { Download, Send, X } from "lucide-react";
import { useMemo, useState } from "react";

import { BOTON_SECUNDARIO } from "@/components/pedidos-ui";
import { INPUT_CLASS, Modal, PRIMARY_BUTTON_CLASS } from "@/components/ui";
import { AGENCIAS_SHALOM } from "@/lib/agencias-shalom";
import {
  cajaShalom,
  documentosRechazadosShalom,
  llenarHojaShalom,
  problemasDeFilaShalom,
  productosPrincipales,
  sugerirAgencia,
  textoDeShalom,
  type CajaShalom,
  type FilaShalom,
} from "@/lib/envios-masivos";
import type { Pedido } from "@/lib/pedidos";
import type { ResultadoShalom } from "@/lib/shalom-server";

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
export function EnvioShalom({
  pedidos,
  onClose,
  onNotice,
  onRegistrado,
}: {
  pedidos: Pedido[];
  onClose: () => void;
  onNotice: (mensaje: string) => void;
  onRegistrado?: () => void;
}) {
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
  const [resultado, setResultado] = useState<ResultadoShalom | null>(null);
  const [errorRegistro, setErrorRegistro] = useState<string | null>(null);
  const [individuales, setIndividuales] = useState<ResultadoShalom | null>(null);

  const cambiar = (i: number, cambio: Partial<Fila>) => setFilas((actual) => actual.map((f, j) => (j === i ? { ...f, ...cambio } : f)));
  const quitar = (id: string) => setFilas((actual) => actual.filter((f) => f.pedido.id !== id));
  // Los DNI que Shalom no reconoce: si se corrige el DNI, la fila deja de estar marcada.
  const rechazados = new Set(errorRegistro ? documentosRechazadosShalom(errorRegistro) : []);
  const filasRechazadas = filas.filter((f) => rechazados.has(f.documento.replace(/\D/g, "")));

  const problemas = filas.map((f) => problemasDeFilaShalom(f, AGENCIAS_SHALOM));
  const conProblemas = problemas.filter((p) => p.length > 0).length;

  /** El Excel de Shalom con los envíos de la tabla (y recuerda las agencias elegidas). */
  const armarArchivo = async () => {
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
    return zip;
  };

  const descargarArchivo = async () => {
    setGenerando(true);
    try {
      const zip = await armarArchivo();
      const archivo = await zip.generateAsync({ type: "blob", compression: "DEFLATE", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
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

  /** Los que la carga masiva no acepta, como "envío individual" de Shalom PRO. */
  const registrarIndividuales = async () => {
    setGenerando(true);
    try {
      const r = await registrarIndividualesEnShalom(
        filasRechazadas.map((f) => ({
          pedidoId: f.pedido.id,
          dni: f.documento,
          celular: f.telefono,
          cliente: f.pedido.cliente,
          agencia: f.destino,
          caja: f.caja,
        })),
      );
      if (!r.ok) return setErrorRegistro(r.error);
      setIndividuales(r.resultado);
      const hechos = new Set(r.resultado.registrados.map((x) => x.codigo));
      if (hechos.size) {
        setFilas((actual) => actual.filter((f) => !hechos.has(f.pedido.codigo)));
        setErrorRegistro(null);
        onRegistrado?.();
      }
    } catch (falla) {
      setErrorRegistro(falla instanceof Error ? falla.message : "No se pudo registrar el envío individual.");
    } finally {
      setGenerando(false);
    }
  };

  const registrar = async () => {
    setGenerando(true);
    setResultado(null);
    setErrorRegistro(null);
    try {
      const zip = await armarArchivo();
      const base64 = await zip.generateAsync({ type: "base64", compression: "DEFLATE" });
      const r = await registrarPedidosEnShalom(
        base64,
        filas.map((f) => f.pedido.id),
        // Por si Shalom no tiene a algún destinatario: el CRM lo registra.
        filas.map((f) => ({ dni: f.documento, celular: f.telefono, cliente: f.pedido.cliente })),
      );
      if (!r.ok) setErrorRegistro(textoDeShalom(r.error));
      else {
        setResultado(r.resultado);
        onRegistrado?.();
      }
    } catch (falla) {
      setErrorRegistro(falla instanceof Error ? falla.message : "No se pudo registrar en Shalom.");
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
                const rechazado = rechazados.has(f.documento.replace(/\D/g, ""));
                return (
                  <tr
                    key={f.pedido.id}
                    className={`border-t border-neutral-100 align-top dark:border-white/5 ${rechazado ? "bg-red-50 dark:bg-red-500/10" : ""}`}
                  >
                    <td className="p-2">
                      <span className="flex items-start justify-between gap-2">
                        <b>{f.pedido.codigo}</b>
                        <button
                          type="button"
                          onClick={() => quitar(f.pedido.id)}
                          title="Quitar de esta tanda (el pedido no cambia)"
                          className="cursor-pointer rounded p-0.5 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-white/10"
                        >
                          <X className="size-3.5" />
                        </button>
                      </span>
                      {rechazado && (
                        <span className="mt-1 block font-semibold text-red-700 dark:text-red-300">
                          Shalom no reconoce este DNI: revísalo, o quita este pedido y regístralo como envío individual en Shalom PRO.
                        </span>
                      )}
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
        {errorRegistro && (
          <div className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-500/10 dark:text-red-200">
            <p className="whitespace-pre-line">{errorRegistro}</p>
            {filasRechazadas.length > 0 && (
              <p className="mt-2 text-xs">
                Shalom rechaza toda la tanda si una fila tiene error, así que <b>no se registró ninguno</b>. Corrige los DNI marcados en rojo, o
                quítalos con el botón de abajo y registra los demás.
              </p>
            )}
          </div>
        )}
        {individuales && (
          <div className="space-y-1 rounded-xl border border-sky-300 bg-sky-50 p-3 text-xs dark:border-sky-400/30 dark:bg-sky-400/10">
            <p className="font-semibold">Envíos individuales: {individuales.registrados.length} registrado(s).</p>
            {individuales.registrados.map((r) => (
              <p key={r.codigo}>
                ✅ <b>{r.codigo}</b> · {r.tracking}
                {r.costo !== null && ` · S/ ${r.costo.toFixed(2)}`}
              </p>
            ))}
            {individuales.conError.map((e) => (
              <p key={e} className="text-red-800 dark:text-red-200">
                ⚠️ {e}
              </p>
            ))}
            {individuales.registrados.length > 0 && filas.length > 0 && <p>Ahora registra los demás con &quot;Registrar en Shalom&quot;.</p>}
          </div>
        )}
        {resultado && (
          <div className="space-y-2 rounded-xl border border-emerald-300 bg-emerald-50 p-3 dark:border-emerald-400/30 dark:bg-emerald-400/10">
            <p className="font-semibold">
              Shalom: {resultado.mensaje} · {resultado.registrados.length} pedido(s) ya tienen tracking, clave y costo en el CRM.
            </p>
            {resultado.registrados.length > 0 && (
              <ul className="grid gap-1 text-xs sm:grid-cols-2">
                {resultado.registrados.map((r) => (
                  <li key={r.codigo}>
                    ✅ <b>{r.codigo}</b> · {r.tracking}
                    {r.costo !== null && ` · S/ ${r.costo.toFixed(2)}`}
                  </li>
                ))}
              </ul>
            )}
            {(resultado.clientesNuevos?.length ?? 0) > 0 && (
              <p className="text-xs">
                👤 Shalom no tenía a {resultado.clientesNuevos?.length} destinatario(s) y el CRM los registró: {resultado.clientesNuevos?.join(" · ")}
              </p>
            )}
            {resultado.conError.length > 0 && (
              <p className="text-xs text-red-800 dark:text-red-200">
                ⚠️ Shalom no aceptó: {resultado.conError.join(" · ")}. Corrígelos en Shalom PRO (registro masivo) o aquí y vuelve a intentar.
              </p>
            )}
            {resultado.sinTracking.length > 0 && (
              <p className="text-xs text-amber-800 dark:text-amber-200">
                ⚠️ Todavía sin tracking: {resultado.sinTracking.join(", ")}. Shalom a veces tarda: se completan solos en la próxima actualización
                (cada 12 horas o con &quot;Actualizar Shalom&quot;).
              </p>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {conProblemas > 0 && <span className="mr-auto text-xs font-semibold text-red-700 dark:text-red-300">{conProblemas} envío(s) con datos por corregir</span>}
          <button type="button" onClick={onClose} className={BOTON_SECUNDARIO}>
            Cerrar
          </button>
          {filasRechazadas.length > 0 && !resultado && (
            <button type="button" disabled={generando} onClick={() => void registrarIndividuales()} className={BOTON_SECUNDARIO}>
              <Send className="size-4" /> Registrar {filasRechazadas.length === 1 ? "ese" : `esos ${filasRechazadas.length}`} como envío individual
            </button>
          )}
          {filasRechazadas.length > 0 && !resultado && (
            <button
              type="button"
              disabled={generando}
              onClick={() => {
                const ids = new Set(filasRechazadas.map((f) => f.pedido.id));
                setFilas((actual) => actual.filter((f) => !ids.has(f.pedido.id)));
                setErrorRegistro(null);
              }}
              className={BOTON_SECUNDARIO}
            >
              <X className="size-4" /> Quitar los {filasRechazadas.length} rechazados
            </button>
          )}
          <button type="button" disabled={generando || filas.length === 0 || conProblemas > 0} onClick={descargarArchivo} className={BOTON_SECUNDARIO}>
            <Download className="size-4" /> Descargar archivo
          </button>
          <button
            type="button"
            disabled={generando || filas.length === 0 || conProblemas > 0 || !!resultado}
            onClick={registrar}
            className={PRIMARY_BUTTON_CLASS}
          >
            <Send className="size-4" /> {generando ? "Registrando en Shalom…" : `Registrar en Shalom (${filas.length})`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
