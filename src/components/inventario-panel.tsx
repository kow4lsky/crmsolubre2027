"use client";

import { AlertTriangle, ArrowRightLeft, Boxes, PackageCheck, PackagePlus, Upload, Warehouse } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { BOTON_SECUNDARIO } from "@/components/pedidos-ui";
import { Card, INPUT_CLASS, Modal, PRIMARY_BUTTON_CLASS } from "@/components/ui";
import {
  TIPOS_DE_MOVIMIENTO,
  diasQueAlcanza,
  emparejarConProductos,
  leerReporteSwayp,
  type Almacen,
  type FilaDeStock,
  type FilaSwayp,
} from "@/lib/inventario";
import { leerXlsx } from "@/lib/leer-xlsx";
import type { RolVenta } from "@/lib/pedidos";
import { getSupabaseBrowser } from "@/lib/supabase/browser";

type AlmacenFila = { codigo: Almacen; nombre: string; lo_maneja: "swayp" | "propio"; iniciado_at: string | null };
type Producto = { id: string; nombre: string; codigo_swayp: string | null; activo: boolean; orden: number };
type Pestana = "stock" | "regresar" | "movimientos" | "cuadre";

const ERROR_CLASS = "rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-500/10 dark:text-red-200";

function mensajeDe(error: { message: string } | null | undefined) {
  if (!error) return null;
  if (/stock_de_inventario|almacenes|does not exist|inventario_/.test(error.message)) {
    return "Falta correr el SQL del inventario en Supabase (202612100001_inventario.sql).";
  }
  return error.message;
}

/**
 * Inventario: el stock de la bodega de Swayp y del almacén de Solubre, la
 * mercadería que está por regresar, el kárdex y el cuadre con el reporte de
 * Swayp. Lo ven el administrador y el encargado.
 */
export function InventarioPanel({
  workspaceId,
  rolVenta,
  timezone,
  onNotice,
}: {
  workspaceId: string;
  rolVenta: RolVenta;
  timezone: string;
  onNotice: (mensaje: string) => void;
}) {
  const supabase = getSupabaseBrowser();
  const esAdmin = rolVenta === "admin";
  const [pestana, setPestana] = useState<Pestana>("stock");
  const [almacen, setAlmacen] = useState<Almacen>("SWAYP");
  const [almacenes, setAlmacenes] = useState<AlmacenFila[]>([]);
  const [stock, setStock] = useState<FilaDeStock[] | null>(null);
  const [productos, setProductos] = useState<Producto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);
  const recargar = () => setRecarga((n) => n + 1);

  useEffect(() => {
    let vigente = true;
    void (async () => {
      const [a, s, p] = await Promise.all([
        supabase.from("almacenes").select("codigo, nombre, lo_maneja, iniciado_at").eq("workspace_id", workspaceId).order("codigo", { ascending: false }),
        supabase.rpc("stock_de_inventario", { ws: workspaceId }),
        supabase.from("productos").select("id, nombre, codigo_swayp, activo, orden").eq("workspace_id", workspaceId).order("orden").order("nombre"),
      ]);
      if (!vigente) return;
      const falla = a.error ?? s.error ?? p.error;
      if (falla) return setError(mensajeDe(falla));
      setError(null);
      setAlmacenes((a.data ?? []) as AlmacenFila[]);
      setStock((s.data ?? []) as FilaDeStock[]);
      setProductos((p.data ?? []) as Producto[]);
    })();
    return () => {
      vigente = false;
    };
  }, [supabase, workspaceId, recarga]);

  const actual = almacenes.find((a) => a.codigo === almacen);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Boxes className="size-6" /> Inventario
          </h1>
          <p className="text-sm text-neutral-500">
            Lo que hay en cada almacén, lo que salió con pedidos y lo que tiene que regresar. Se descuenta recién cuando se entrega.
          </p>
        </div>
        <div className="flex flex-wrap gap-1 rounded-xl bg-[#f3f1ea] p-1 text-sm dark:bg-white/5">
          {(
            [
              ["stock", "Stock"],
              ["regresar", "Por regresar"],
              ["movimientos", "Movimientos"],
              ["cuadre", "Cuadre con Swayp"],
            ] as [Pestana, string][]
          ).map(([id, texto]) => (
            <button
              key={id}
              type="button"
              onClick={() => setPestana(id)}
              className={`cursor-pointer rounded-lg px-3 py-1.5 font-medium ${pestana === id ? "bg-white shadow-sm dark:bg-white/15" : "text-neutral-600 dark:text-neutral-300"}`}
            >
              {texto}
            </button>
          ))}
        </div>
      </div>

      {error && <p className={ERROR_CLASS}>{error}</p>}

      {!error && pestana === "stock" && (
        <>
          <div className="flex flex-wrap gap-2">
            {almacenes.map((a) => (
              <button
                key={a.codigo}
                type="button"
                onClick={() => setAlmacen(a.codigo)}
                className={`${BOTON_SECUNDARIO} ${almacen === a.codigo ? "border-amber-400! bg-amber-50! font-semibold dark:bg-amber-400/10!" : ""}`}
              >
                <Warehouse className="size-4" /> {a.nombre}
              </button>
            ))}
          </div>
          {actual && !actual.iniciado_at ? (
            actual.lo_maneja === "swayp" ? (
              <Card className="p-5 text-sm">
                <p className="font-semibold">Todavía no se cargó el stock de {actual.nombre}.</p>
                <p className="mt-1 text-neutral-600 dark:text-neutral-300">
                  En Swayp ve a <b>Inventario → Exportar a Excel</b> y súbelo en la pestaña <b>Cuadre con Swayp</b>. Desde ahí los
                  pedidos mueven el inventario solos.
                </p>
                <button type="button" onClick={() => setPestana("cuadre")} className={`${PRIMARY_BUTTON_CLASS} mt-3`}>
                  <Upload className="size-4" /> Ir a Cuadre con Swayp
                </button>
              </Card>
            ) : (
              <Conteo
                workspaceId={workspaceId}
                almacen={actual}
                productos={productos.filter((p) => p.activo)}
                inicial
                esAdmin={esAdmin}
                onListo={(m) => {
                  onNotice(m);
                  recargar();
                }}
              />
            )
          ) : (
            actual &&
            stock && (
              <TablaDeStock
                workspaceId={workspaceId}
                almacen={actual}
                almacenes={almacenes}
                filas={stock.filter((s) => s.almacen === almacen)}
                productos={productos}
                esAdmin={esAdmin}
                onCambio={(m) => {
                  if (m) onNotice(m);
                  recargar();
                }}
              />
            )
          )}
        </>
      )}

      {!error && pestana === "regresar" && <PorRegresar workspaceId={workspaceId} timezone={timezone} onNotice={onNotice} />}
      {!error && pestana === "movimientos" && <Movimientos workspaceId={workspaceId} almacenes={almacenes} timezone={timezone} />}
      {!error && pestana === "cuadre" && (
        <CuadreSwayp
          workspaceId={workspaceId}
          almacen={almacenes.find((a) => a.codigo === "SWAYP")}
          stock={(stock ?? []).filter((s) => s.almacen === "SWAYP")}
          productos={productos}
          esAdmin={esAdmin}
          onListo={(m) => {
            onNotice(m);
            recargar();
            setAlmacen("SWAYP");
            setPestana("stock");
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ stock */

function TablaDeStock({
  workspaceId,
  almacen,
  almacenes,
  filas,
  productos,
  esAdmin,
  onCambio,
}: {
  workspaceId: string;
  almacen: AlmacenFila;
  almacenes: AlmacenFila[];
  filas: FilaDeStock[];
  productos: Producto[];
  esAdmin: boolean;
  onCambio: (mensaje?: string) => void;
}) {
  const supabase = getSupabaseBrowser();
  const [movimiento, setMovimiento] = useState<"INGRESO" | "AJUSTE" | "TRANSFERENCIA" | "CONTEO" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const propio = almacen.lo_maneja === "propio";

  const guardarMinimo = async (fila: FilaDeStock, valor: string) => {
    const minimo = Math.max(0, Math.floor(Number(valor) || 0));
    if (minimo === fila.minimo) return;
    const { error: falla } = await supabase
      .from("inventario_minimos")
      .upsert({ workspace_id: workspaceId, almacen: almacen.codigo, producto_id: fila.producto_id, minimo });
    if (falla) return setError(falla.message);
    onCambio(`Mínimo de ${fila.producto} en ${almacen.nombre}: ${minimo}.`);
  };

  const total = (campo: "bodega" | "camino") => filas.reduce((n, f) => n + f[campo], 0);

  return (
    <Card className="p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Dato titulo="En el almacén" valor={total("bodega")} detalle="Físicamente en la bodega" />
        <Dato titulo="En camino" valor={total("camino")} detalle="Salió con pedidos, sin entregar ni regresar" />
        <Dato titulo="Stock total" valor={total("bodega") + total("camino")} detalle="Se descuenta al entregar" />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {propio ? (
          <>
            <button type="button" onClick={() => setMovimiento("INGRESO")} className={PRIMARY_BUTTON_CLASS}>
              <PackagePlus className="size-4" /> Ingreso de mercadería
            </button>
            <button type="button" onClick={() => setMovimiento("TRANSFERENCIA")} className={BOTON_SECUNDARIO}>
              <ArrowRightLeft className="size-4" /> Enviar a Swayp
            </button>
            <button type="button" onClick={() => setMovimiento("AJUSTE")} className={BOTON_SECUNDARIO}>
              Ajuste
            </button>
            {esAdmin && (
              <button type="button" onClick={() => setMovimiento("CONTEO")} className={BOTON_SECUNDARIO}>
                Conteo completo
              </button>
            )}
          </>
        ) : (
          <p className="text-xs text-neutral-500">
            Este almacén lo maneja Swayp: se mueve solo con los pedidos y se corrige subiendo su reporte en &quot;Cuadre con Swayp&quot;.
          </p>
        )}
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-[#e7e3d6] text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-white/10">
              <th className="px-2 py-2">Producto</th>
              <th className="px-2 py-2 text-right">En almacén</th>
              <th className="px-2 py-2 text-right">En camino</th>
              <th className="px-2 py-2 text-right">Total</th>
              <th className="px-2 py-2 text-right">Mínimo</th>
              <th className="px-2 py-2 text-right">Alcanza</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => {
              const bajo = f.minimo > 0 && f.bodega <= f.minimo;
              const dias = diasQueAlcanza(f.bodega, f.por_dia);
              return (
                <tr key={f.producto_id} className={`border-b border-[#efece2] last:border-0 dark:border-white/5 ${f.activo ? "" : "opacity-60"}`}>
                  <td className="px-2 py-2 font-semibold">
                    {f.producto}
                    {f.codigo_swayp && <span className="ml-2 font-mono text-[10px] text-neutral-400">{f.codigo_swayp}</span>}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${bajo ? "bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300" : "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300"}`}
                    >
                      {bajo && <AlertTriangle className="size-3" />}
                      {f.bodega}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right">{f.camino || "—"}</td>
                  <td className="px-2 py-2 text-right font-semibold">{f.bodega + f.camino}</td>
                  <td className="px-2 py-2 text-right">
                    <input
                      key={`${f.producto_id}-${f.minimo}`}
                      defaultValue={f.minimo || ""}
                      inputMode="numeric"
                      placeholder="—"
                      onBlur={(e) => void guardarMinimo(f, e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                      className="w-20 rounded-lg border border-[#ddd8c9] bg-white px-2 py-1 text-right dark:border-white/10 dark:bg-white/5"
                      aria-label={`Mínimo de ${f.producto}`}
                    />
                  </td>
                  <td className="px-2 py-2 text-right text-xs text-neutral-500">
                    {dias === null ? "—" : `${dias} día${dias === 1 ? "" : "s"}`}
                    {f.por_dia > 0 && <span className="block text-[10px]">{f.por_dia}/día</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-neutral-500">
        &quot;Alcanza&quot; usa lo entregado en los últimos 7 días. Con el mínimo puesto, te aparece una alerta al entrar al CRM cuando quede
        esa cantidad o menos.
      </p>
      {error && <p className={`${ERROR_CLASS} mt-3`}>{error}</p>}

      {movimiento === "CONTEO" && (
        <Modal title={`Conteo de ${almacen.nombre}`} onClose={() => setMovimiento(null)} ancho="max-w-2xl">
          <Conteo
            workspaceId={workspaceId}
            almacen={almacen}
            productos={productos.filter((p) => p.activo || filas.some((f) => f.producto_id === p.id && f.bodega !== 0))}
            actuales={Object.fromEntries(filas.map((f) => [f.producto_id, f.bodega]))}
            esAdmin={esAdmin}
            onListo={(m) => {
              setMovimiento(null);
              onCambio(m);
            }}
          />
        </Modal>
      )}
      {movimiento && movimiento !== "CONTEO" && (
        <MovimientoManual
          workspaceId={workspaceId}
          almacen={almacen}
          destinos={almacenes.filter((a) => a.codigo !== almacen.codigo)}
          tipo={movimiento}
          productos={productos.filter((p) => p.activo)}
          onClose={() => setMovimiento(null)}
          onListo={(m) => {
            setMovimiento(null);
            onCambio(m);
          }}
        />
      )}
    </Card>
  );
}

function Dato({ titulo, valor, detalle }: { titulo: string; valor: number; detalle: string }) {
  return (
    <div className="rounded-xl bg-[#f9f8f3] p-3 dark:bg-white/5">
      <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{titulo}</p>
      <p className="text-2xl font-semibold">{valor.toLocaleString("es-PE")}</p>
      <p className="text-xs text-neutral-500">{detalle}</p>
    </div>
  );
}

function MovimientoManual({
  workspaceId,
  almacen,
  destinos,
  tipo,
  productos,
  onClose,
  onListo,
}: {
  workspaceId: string;
  almacen: AlmacenFila;
  destinos: AlmacenFila[];
  tipo: "INGRESO" | "AJUSTE" | "TRANSFERENCIA";
  productos: Producto[];
  onClose: () => void;
  onListo: (mensaje: string) => void;
}) {
  const supabase = getSupabaseBrowser();
  const [producto, setProducto] = useState("");
  const [cantidad, setCantidad] = useState("");
  const [nota, setNota] = useState("");
  const [destino, setDestino] = useState<string>(destinos[0]?.codigo ?? "");
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titulo = tipo === "INGRESO" ? "Ingreso de mercadería" : tipo === "AJUSTE" ? "Ajuste" : "Enviar a otro almacén";

  const guardar = async () => {
    const n = Math.trunc(Number(cantidad));
    if (!producto) return setError("Elige el producto.");
    if (!n) return setError("Escribe la cantidad.");
    setOcupado(true);
    const { error: falla } = await supabase.rpc("registrar_movimiento", {
      ws: workspaceId,
      almacen: almacen.codigo,
      producto,
      tipo,
      cantidad: n,
      nota: nota.trim() || null,
      destino: tipo === "TRANSFERENCIA" ? destino : null,
    });
    setOcupado(false);
    if (falla) return setError(falla.message);
    const nombre = productos.find((p) => p.id === producto)?.nombre ?? "";
    onListo(
      tipo === "INGRESO"
        ? `Ingresaron ${n} ${nombre} a ${almacen.nombre}.`
        : tipo === "AJUSTE"
          ? `Ajuste de ${n > 0 ? "+" : ""}${n} ${nombre} en ${almacen.nombre}.`
          : `Enviaste ${n} ${nombre} a ${destinos.find((d) => d.codigo === destino)?.nombre ?? destino}.`,
    );
  };

  return (
    <Modal title={titulo} onClose={onClose} ancho="max-w-md">
      <div className="mt-4 space-y-3 text-sm">
        <select value={producto} onChange={(e) => setProducto(e.target.value)} className={INPUT_CLASS} aria-label="Producto">
          <option value="">Elige el producto…</option>
          {productos.map((p) => (
            <option key={p.id} value={p.id}>
              {p.nombre}
            </option>
          ))}
        </select>
        <input
          value={cantidad}
          onChange={(e) => setCantidad(e.target.value.replace(tipo === "AJUSTE" ? /[^\d-]/g : /\D/g, ""))}
          inputMode="numeric"
          placeholder={tipo === "AJUSTE" ? "Cantidad: positiva suma, negativa resta (ej. -3)" : "Cantidad"}
          className={INPUT_CLASS}
        />
        {tipo === "TRANSFERENCIA" && (
          <select value={destino} onChange={(e) => setDestino(e.target.value)} className={INPUT_CLASS} aria-label="Destino">
            {destinos.map((d) => (
              <option key={d.codigo} value={d.codigo}>
                A {d.nombre}
              </option>
            ))}
          </select>
        )}
        <textarea
          value={nota}
          onChange={(e) => setNota(e.target.value)}
          rows={2}
          placeholder={tipo === "AJUSTE" ? "Motivo (obligatorio): conteo, producto dañado…" : "Nota (opcional): proveedor, guía…"}
          className={INPUT_CLASS}
        />
        {error && <p className={ERROR_CLASS}>{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={BOTON_SECUNDARIO}>
            Cancelar
          </button>
          <button type="button" disabled={ocupado} onClick={() => void guardar()} className={PRIMARY_BUTTON_CLASS}>
            {ocupado ? "Guardando…" : "Guardar"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** El conteo de un almacén propio: la primera vez es el stock inicial. */
function Conteo({
  workspaceId,
  almacen,
  productos,
  actuales = {},
  inicial = false,
  esAdmin,
  onListo,
}: {
  workspaceId: string;
  almacen: AlmacenFila;
  productos: Producto[];
  actuales?: Record<string, number>;
  inicial?: boolean;
  esAdmin: boolean;
  onListo: (mensaje: string) => void;
}) {
  const supabase = getSupabaseBrowser();
  const [valores, setValores] = useState<Record<string, string>>(() =>
    Object.fromEntries(productos.map((p) => [p.id, actuales[p.id] !== undefined ? String(actuales[p.id]) : ""])),
  );
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const guardar = async () => {
    setOcupado(true);
    const filas = productos.map((p) => ({ producto_id: p.id, bodega: Math.max(0, Math.trunc(Number(valores[p.id]) || 0)) }));
    const { data, error: falla } = await supabase.rpc("cuadrar_almacen", {
      ws: workspaceId,
      almacen: almacen.codigo,
      filas,
      nota: inicial ? "Stock inicial (conteo)" : "Conteo completo",
    });
    setOcupado(false);
    if (falla) return setError(falla.message);
    onListo(inicial ? `Listo: ${almacen.nombre} empezó con su stock inicial.` : `Conteo guardado: ${Number(data ?? 0)} producto(s) ajustados.`);
  };

  return (
    <Card className="p-5 text-sm">
      {inicial && (
        <>
          <p className="font-semibold">Carga el stock inicial de {almacen.nombre}</p>
          <p className="mt-1 text-neutral-600 dark:text-neutral-300">
            Cuenta lo que hay hoy en el almacén y escríbelo. Desde ahí, los ingresos, envíos y pedidos lo mueven solos.
          </p>
        </>
      )}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {productos.map((p) => (
          <label key={p.id} className="flex items-center justify-between gap-2 rounded-lg bg-[#f9f8f3] px-3 py-2 dark:bg-white/5">
            <span className="font-medium">{p.nombre}</span>
            <input
              value={valores[p.id] ?? ""}
              onChange={(e) => setValores((v) => ({ ...v, [p.id]: e.target.value.replace(/\D/g, "") }))}
              inputMode="numeric"
              placeholder="0"
              className="w-24 rounded-lg border border-[#ddd8c9] bg-white px-2 py-1 text-right dark:border-white/10 dark:bg-white/5"
            />
          </label>
        ))}
      </div>
      {error && <p className={`${ERROR_CLASS} mt-3`}>{error}</p>}
      {esAdmin ? (
        <button type="button" disabled={ocupado} onClick={() => void guardar()} className={`${PRIMARY_BUTTON_CLASS} mt-4`}>
          {ocupado ? "Guardando…" : inicial ? "Guardar stock inicial" : "Guardar conteo"}
        </button>
      ) : (
        <p className="mt-3 text-xs text-neutral-500">Solo el administrador puede guardar el conteo.</p>
      )}
    </Card>
  );
}

/* --------------------------------------------------------- por regresar */

type PedidoPorRegresar = {
  id: string;
  codigo: string;
  cliente: string;
  pedido: string | null;
  estado: string;
  courier: string | null;
  inv_almacen: string | null;
  fecha_estado: string | null;
};

function PorRegresar({ workspaceId, timezone, onNotice }: { workspaceId: string; timezone: string; onNotice: (m: string) => void }) {
  const supabase = getSupabaseBrowser();
  const [filas, setFilas] = useState<PedidoPorRegresar[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);
  const [ahora, setAhora] = useState(0);

  useEffect(() => {
    let vigente = true;
    void (async () => {
      const { data, error: falla } = await supabase
        .from("pedidos")
        .select("id, codigo, cliente, pedido, estado, courier, inv_almacen, fecha_estado")
        .eq("workspace_id", workspaceId)
        .eq("inv_estado", "POR REGRESAR")
        .order("fecha_estado", { ascending: true })
        .limit(300);
      if (!vigente) return;
      if (falla) setError(mensajeDe(falla));
      else {
        setFilas((data ?? []) as PedidoPorRegresar[]);
        setAhora(Date.now());
      }
    })();
    return () => {
      vigente = false;
    };
  }, [supabase, workspaceId, recarga]);

  const confirmar = async (p: PedidoPorRegresar) => {
    setOcupado(p.id);
    const { error: falla } = await supabase.rpc("confirmar_retorno", { ws: workspaceId, pedido: p.id, nota: null });
    setOcupado(null);
    if (falla) return setError(falla.message);
    onNotice(`${p.codigo}: la mercadería volvió a ${p.inv_almacen === "SWAYP" ? "la bodega de Swayp" : "Solubre"}.`);
    setRecarga((n) => n + 1);
  };

  const dias = (fecha: string | null) => (fecha && ahora ? Math.floor((ahora - new Date(fecha).getTime()) / 86_400_000) : null);

  return (
    <Card className="p-4">
      <p className="text-sm text-neutral-600 dark:text-neutral-300">
        Pedidos que salieron y no se entregaron (devolución, rechazo…): su mercadería tiene que volver al almacén. Los de Swayp se
        confirman solos cuando Swayp avisa que la recibió; los demás, toca <b>Llegó al almacén</b> cuando la recibas.
      </p>
      {error && <p className={`${ERROR_CLASS} mt-3`}>{error}</p>}
      {filas && filas.length === 0 && <p className="mt-4 text-sm text-neutral-500">No hay nada pendiente de regresar. 👍</p>}
      {filas && filas.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-[#e7e3d6] text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-white/10">
                <th className="px-2 py-2">Cod</th>
                <th className="px-2 py-2">Cliente</th>
                <th className="px-2 py-2">Pedido</th>
                <th className="px-2 py-2">Estado</th>
                <th className="px-2 py-2">Almacén</th>
                <th className="px-2 py-2 text-right">Días</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {filas.map((p) => {
                const d = dias(p.fecha_estado);
                return (
                  <tr key={p.id} className="border-b border-[#efece2] last:border-0 dark:border-white/5">
                    <td className="px-2 py-2 font-mono">{p.codigo}</td>
                    <td className="px-2 py-2 font-semibold">{p.cliente}</td>
                    <td className="px-2 py-2">{p.pedido}</td>
                    <td className="px-2 py-2 text-xs">{p.estado}</td>
                    <td className="px-2 py-2 text-xs">{p.inv_almacen}</td>
                    <td
                      className={`px-2 py-2 text-right font-semibold ${d !== null && d > 7 ? "text-red-700 dark:text-red-300" : ""}`}
                      title={p.fecha_estado ? new Date(p.fecha_estado).toLocaleString("es-PE", { timeZone: timezone }) : undefined}
                    >
                      {d ?? "—"}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <button type="button" disabled={ocupado === p.id} onClick={() => void confirmar(p)} className={BOTON_SECUNDARIO}>
                        <PackageCheck className="size-4" /> Llegó al almacén
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------ movimientos */

type Movimiento = {
  id: string;
  almacen: string;
  producto: string;
  tipo: string;
  bodega: number;
  camino: number;
  pedido_codigo: string | null;
  nota: string | null;
  usuario: string | null;
  created_at: string;
};

function Movimientos({ workspaceId, almacenes, timezone }: { workspaceId: string; almacenes: AlmacenFila[]; timezone: string }) {
  const supabase = getSupabaseBrowser();
  const [filtro, setFiltro] = useState("");
  const [buscar, setBuscar] = useState("");
  const [filas, setFilas] = useState<Movimiento[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vigente = true;
    void (async () => {
      let consulta = supabase
        .from("inventario_movimientos")
        .select("id, almacen, producto, tipo, bodega, camino, pedido_codigo, nota, usuario, created_at")
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: false })
        .limit(300);
      if (filtro) consulta = consulta.eq("almacen", filtro);
      const { data, error: falla } = await consulta;
      if (!vigente) return;
      if (falla) setError(mensajeDe(falla));
      else setFilas((data ?? []) as Movimiento[]);
    })();
    return () => {
      vigente = false;
    };
  }, [supabase, workspaceId, filtro]);

  const visibles = useMemo(() => {
    const t = buscar.trim().toUpperCase();
    return (filas ?? []).filter((m) => !t || m.producto.toUpperCase().includes(t) || (m.pedido_codigo ?? "").toUpperCase().includes(t));
  }, [filas, buscar]);

  const signo = (n: number) => (n > 0 ? `+${n}` : n < 0 ? String(n) : "—");

  return (
    <Card className="p-4">
      <div className="flex flex-wrap gap-2">
        <select value={filtro} onChange={(e) => setFiltro(e.target.value)} className={`${INPUT_CLASS} max-w-60`} aria-label="Almacén">
          <option value="">Todos los almacenes</option>
          {almacenes.map((a) => (
            <option key={a.codigo} value={a.codigo}>
              {a.nombre}
            </option>
          ))}
        </select>
        <input value={buscar} onChange={(e) => setBuscar(e.target.value)} placeholder="Buscar producto o código de pedido" className={`${INPUT_CLASS} max-w-72`} />
      </div>
      {error && <p className={`${ERROR_CLASS} mt-3`}>{error}</p>}
      {filas && visibles.length === 0 && <p className="mt-4 text-sm text-neutral-500">Todavía no hay movimientos.</p>}
      {visibles.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-[#e7e3d6] text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-white/10">
                <th className="px-2 py-2">Fecha</th>
                <th className="px-2 py-2">Almacén</th>
                <th className="px-2 py-2">Movimiento</th>
                <th className="px-2 py-2">Producto</th>
                <th className="px-2 py-2 text-right">Almacén</th>
                <th className="px-2 py-2 text-right">En camino</th>
                <th className="px-2 py-2">Pedido</th>
                <th className="px-2 py-2">Nota</th>
                <th className="px-2 py-2">Quién</th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((m) => (
                <tr key={m.id} className="border-b border-[#efece2] last:border-0 dark:border-white/5">
                  <td className="whitespace-nowrap px-2 py-2 text-xs">{new Date(m.created_at).toLocaleString("es-PE", { timeZone: timezone })}</td>
                  <td className="px-2 py-2 text-xs">{m.almacen}</td>
                  <td className="px-2 py-2">{TIPOS_DE_MOVIMIENTO[m.tipo] ?? m.tipo}</td>
                  <td className="px-2 py-2 font-semibold">{m.producto}</td>
                  <td className={`px-2 py-2 text-right font-mono ${m.bodega < 0 ? "text-red-700 dark:text-red-300" : m.bodega > 0 ? "text-emerald-700 dark:text-emerald-300" : ""}`}>
                    {signo(m.bodega)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono">{signo(m.camino)}</td>
                  <td className="px-2 py-2 font-mono text-xs">{m.pedido_codigo ?? "—"}</td>
                  <td className="px-2 py-2 text-xs text-neutral-600 dark:text-neutral-300">{m.nota ?? ""}</td>
                  <td className="px-2 py-2 text-xs">{m.usuario ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* -------------------------------------------------------- cuadre con Swayp */

/** "nuevo": se crea el producto en el CRM; "": no se usa esa fila. */
type Eleccion = string;

function CuadreSwayp({
  workspaceId,
  almacen,
  stock,
  productos,
  esAdmin,
  onListo,
}: {
  workspaceId: string;
  almacen: AlmacenFila | undefined;
  stock: FilaDeStock[];
  productos: Producto[];
  esAdmin: boolean;
  onListo: (mensaje: string) => void;
}) {
  const supabase = getSupabaseBrowser();
  const [filas, setFilas] = useState<FilaSwayp[] | null>(null);
  const [elegidos, setElegidos] = useState<Record<string, Eleccion>>({});
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const inicial = !almacen?.iniciado_at;

  const leer = async (archivo: File | undefined) => {
    if (!archivo) return;
    setError(null);
    try {
      const leidas = leerReporteSwayp(await leerXlsx(await archivo.arrayBuffer()));
      const pares = emparejarConProductos(leidas, productos);
      setFilas(leidas);
      setElegidos(Object.fromEntries(leidas.map((f) => [f.codigo, pares.get(f.codigo)?.id ?? "nuevo"])));
    } catch (e) {
      setFilas(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const enCrm = (productoId: string) => stock.find((s) => s.producto_id === productoId);

  const aplicar = async () => {
    if (!filas || !almacen) return;
    setOcupado(true);
    setError(null);
    const finales: { producto_id: string; bodega: number }[] = [];
    let orden = Math.max(0, ...productos.map((p) => p.orden)) + 1;
    for (const fila of filas) {
      let id = elegidos[fila.codigo];
      if (!id) continue;
      if (id === "nuevo") {
        // Lo que sólo existe en Swayp se crea desactivado: no aparece en los
        // pedidos hasta que lo actives en Configuración → Productos.
        const { data, error: falla } = await supabase
          .from("productos")
          .insert({ workspace_id: workspaceId, nombre: fila.nombre.trim().toUpperCase(), orden: orden++, activo: false, codigo_swayp: fila.codigo })
          .select("id")
          .single();
        if (falla || !data) {
          setOcupado(false);
          return setError(`No se pudo crear ${fila.nombre}: ${falla?.message ?? ""}`);
        }
        id = data.id as string;
      } else {
        const producto = productos.find((p) => p.id === id);
        if (producto && producto.codigo_swayp !== fila.codigo) {
          await supabase.from("productos").update({ codigo_swayp: fila.codigo }).eq("id", id);
        }
      }
      finales.push({ producto_id: id, bodega: fila.cantidad });
    }
    const { data, error: falla } = await supabase.rpc("cuadrar_almacen", {
      ws: workspaceId,
      almacen: "SWAYP",
      filas: finales,
      nota: inicial ? "Stock inicial (reporte de Swayp)" : "Cuadre con el reporte de Swayp",
    });
    setOcupado(false);
    if (falla) return setError(falla.message);
    onListo(
      inicial
        ? "Listo: la bodega de Swayp empezó con el stock de su reporte. Desde ahora los pedidos la mueven solos."
        : `Cuadre listo: ${Number(data ?? 0)} producto(s) ajustados al reporte de Swayp.`,
    );
  };

  return (
    <Card className="p-4 text-sm">
      <p className="text-neutral-600 dark:text-neutral-300">
        En Swayp ve a <b>Inventario → Exportar a Excel</b> y sube ese archivo aquí. El CRM lo compara con lo que calculó y te muestra las
        diferencias producto por producto. {inicial && <b>La primera vez queda como el stock inicial.</b>}
      </p>
      <label className={`${PRIMARY_BUTTON_CLASS} mt-3 inline-flex cursor-pointer`}>
        <Upload className="size-4" /> Subir el Excel de Swayp
        <input type="file" accept=".xlsx" className="hidden" onChange={(e) => void leer(e.target.files?.[0])} />
      </label>
      {error && <p className={`${ERROR_CLASS} mt-3`}>{error}</p>}

      {filas && (
        <>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[860px]">
              <thead>
                <tr className="border-b border-[#e7e3d6] text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-white/10">
                  <th className="px-2 py-2">En Swayp</th>
                  <th className="px-2 py-2">Producto del CRM</th>
                  <th className="px-2 py-2 text-right">Swayp: en bodega</th>
                  <th className="px-2 py-2 text-right">CRM: en almacén</th>
                  <th className="px-2 py-2 text-right">Diferencia</th>
                  <th className="px-2 py-2 text-right">Swayp: tránsito + devolución</th>
                  <th className="px-2 py-2 text-right">CRM: en camino</th>
                </tr>
              </thead>
              <tbody>
                {filas.map((f) => {
                  const eleccion = elegidos[f.codigo] ?? "";
                  const crm = eleccion && eleccion !== "nuevo" ? enCrm(eleccion) : undefined;
                  const diferencia = f.cantidad - (crm?.bodega ?? 0);
                  return (
                    <tr key={f.codigo} className="border-b border-[#efece2] last:border-0 dark:border-white/5">
                      <td className="px-2 py-2">
                        <b>{f.nombre}</b>
                        <span className="ml-1 font-mono text-[10px] text-neutral-400">{f.codigo}</span>
                      </td>
                      <td className="px-2 py-2">
                        <select
                          value={eleccion}
                          onChange={(e) => setElegidos((v) => ({ ...v, [f.codigo]: e.target.value }))}
                          className="w-full rounded-lg border border-[#ddd8c9] bg-white px-2 py-1 dark:border-white/10 dark:bg-white/5"
                          aria-label={`Producto del CRM para ${f.nombre}`}
                        >
                          <option value="nuevo">➕ Crear {f.nombre} (desactivado)</option>
                          <option value="">No usar esta fila</option>
                          {productos.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.nombre}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-2 text-right font-semibold">{f.cantidad}</td>
                      <td className="px-2 py-2 text-right">{eleccion === "nuevo" ? "—" : (crm?.bodega ?? 0)}</td>
                      <td
                        className={`px-2 py-2 text-right font-semibold ${!eleccion || inicial ? "" : diferencia === 0 ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}`}
                      >
                        {!eleccion || inicial ? "—" : diferencia === 0 ? "OK" : diferencia > 0 ? `+${diferencia}` : diferencia}
                      </td>
                      <td className="px-2 py-2 text-right">{f.transito + f.devolucion}</td>
                      <td className="px-2 py-2 text-right">{crm?.camino ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-neutral-500">
            Diferencia = lo que dice Swayp menos lo que calculó el CRM. Si es negativa, en Swayp hay menos de lo que debería: revisa los
            movimientos o reclama a Swayp.
          </p>
          {esAdmin ? (
            <button type="button" disabled={ocupado} onClick={() => void aplicar()} className={`${PRIMARY_BUTTON_CLASS} mt-3`}>
              {ocupado ? "Guardando…" : inicial ? "Guardar como stock inicial" : "Dejar el inventario como dice Swayp"}
            </button>
          ) : (
            <p className="mt-3 text-xs text-neutral-500">Solo el administrador puede aplicar el cuadre.</p>
          )}
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------- alerta al entrar */

type Alerta = { almacen: string; producto: string; bodega: number; minimo: number; por_dia: number };

/**
 * Al entrar al CRM, el administrador y el encargado ven los productos que
 * llegaron a su mínimo. Se puede cerrar: vuelve a salir en la próxima sesión.
 */
export function AlertasDeStock({ workspaceId, onAbrir }: { workspaceId: string; onAbrir: () => void }) {
  const supabase = getSupabaseBrowser();
  const [alertas, setAlertas] = useState<Alerta[]>([]);
  const [cerrada, setCerrada] = useState(() => {
    try {
      return sessionStorage.getItem("crm-solubre:alertas-stock") === "cerrada";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (cerrada) return;
    let vigente = true;
    void (async () => {
      const { data } = await supabase.rpc("alertas_de_stock", { ws: workspaceId });
      if (vigente) setAlertas((data ?? []) as Alerta[]);
    })();
    return () => {
      vigente = false;
    };
  }, [supabase, workspaceId, cerrada]);

  if (cerrada || alertas.length === 0) return null;
  const cerrar = () => {
    setCerrada(true);
    try {
      sessionStorage.setItem("crm-solubre:alertas-stock", "cerrada");
    } catch {
      /* sin almacenamiento: se cierra igual hasta recargar */
    }
  };

  return (
    <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm dark:border-red-500/30 dark:bg-red-500/10">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="flex items-center gap-2 font-semibold text-red-900 dark:text-red-200">
          <AlertTriangle className="size-4" /> {alertas.length === 1 ? "Un producto se está acabando" : `${alertas.length} productos se están acabando`}
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={onAbrir} className={BOTON_SECUNDARIO}>
            Ver inventario
          </button>
          <button type="button" onClick={cerrar} className={BOTON_SECUNDARIO}>
            Cerrar
          </button>
        </div>
      </div>
      <ul className="mt-2 space-y-1 text-red-900 dark:text-red-200">
        {alertas.map((a) => {
          const dias = diasQueAlcanza(a.bodega, Number(a.por_dia));
          return (
            <li key={`${a.almacen}-${a.producto}`}>
              <b>{a.producto}</b> en {a.almacen === "SWAYP" ? "Swayp" : "Solubre"}: quedan <b>{a.bodega}</b> (mínimo {a.minimo})
              {dias !== null && ` · al ritmo de esta semana alcanza para ${dias} día${dias === 1 ? "" : "s"}`}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
