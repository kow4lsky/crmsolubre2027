"use client";

import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Download,
  FileSpreadsheet,
  Plus,
  RefreshCw,
  Search,
  ShoppingBag,
  Truck,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { actualizarShalomAhora } from "@/app/actions";
import { ImportarPedidos } from "@/components/importar-pedidos";
import { EnvioOlva } from "@/components/envio-olva";
import { EnvioShalom } from "@/components/envio-shalom";
import { ImportarShopify } from "@/components/importar-shopify";
import { PedidoAjeno } from "@/components/pedido-ajeno";
import { EnvioSwayp } from "@/components/envio-swayp";
import { IndicadoresPedidos } from "@/components/indicadores-pedidos";
import { PedidoForm } from "@/components/pedido-form";
import { BOTON_SECUNDARIO, EstadoChip, EstadoUnico, descargar } from "@/components/pedidos-ui";
import { INPUT_CLASS, Modal, PRIMARY_BUTTON_CLASS } from "@/components/ui";
import {
  COLUMNAS_PEDIDO,
  COLUMNAS_PEDIDO_SIN_TIPO,
  COLUMNAS_PEDIDO_BASE,
  DESPACHO_LIMA_COLUMNAS,
  DESPACHO_PROVINCIA_COLUMNAS,
  ESTADOS,
  ESTADOS_CERRADOS,
  ETIQUETA_COLUMNAS,
  OPCIONES,
  PEDIDOS_POR_PAGINA,
  SMS_COLUMNAS,
  aCsvExcel,
  aTabulado,
  armarReporte,
  faltantesDeEtiqueta,
  fechaCorta,
  filaDespachoLima,
  filaDespachoProvincia,
  filaEtiqueta,
  filaSms,
  soles,
  terminoDeBusqueda,
  type Pedido,
  type RolVenta,
} from "@/lib/pedidos";
import { getSupabaseBrowser } from "@/lib/supabase/browser";

const SELECT_CLASS =
  "h-10 rounded-xl border border-[#ddd8c9] bg-[#f9f8f3] px-2.5 text-sm outline-none focus:ring-2 focus:ring-amber-500 dark:border-white/10 dark:bg-white/5";

type Filtros = {
  texto: string;
  desde: string;
  hasta: string;
  // Cada filtro de lista admite varias opciones a la vez. Vacío = todos.
  estado: string[];
  asesor: string[];
  destino: string[];
  canal: string[];
  envio: string[];
  courier: string[];
  verDepurados: boolean;
};

const FILTROS_VACIOS: Filtros = {
  texto: "",
  desde: "",
  hasta: "",
  estado: [],
  asesor: [],
  destino: [],
  canal: [],
  envio: [],
  courier: [],
  verDepurados: false,
};

type Despacho = "lima" | "provincia";

export function PedidosPanel({
  workspaceId,
  timezone,
  rolVenta,
  onNotice,
  abrir = null,
}: {
  workspaceId: string;
  timezone: string;
  rolVenta: RolVenta;
  onNotice: (message: string) => void;
  /** Un pedido para abrir apenas se pueda (desde el aviso de llamada). */
  abrir?: { codigo: string; vez: number } | null;
}) {
  const supabase = getSupabaseBrowser();
  const esAdmin = rolVenta === "admin";
  const puedeReporte = rolVenta === "admin" || rolVenta === "encargado";

  const [filtros, setFiltros] = useState<Filtros>(FILTROS_VACIOS);
  const [texto, setTexto] = useState("");
  const [pagina, setPagina] = useState(0);
  const [pedidos, setPedidos] = useState<Pedido[]>([]);
  const [total, setTotal] = useState(0);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);
  // La selección sobrevive al cambio de página: se guardan los pedidos enteros.
  const [seleccion, setSeleccion] = useState<Map<string, Pedido>>(new Map());

  const [abierto, setAbierto] = useState<Pedido | "nuevo" | null>(null);
  const [verReporte, setVerReporte] = useState(false);
  const [despacho, setDespacho] = useState<Despacho | null>(null);
  const [verEtiqueta, setVerEtiqueta] = useState(false);
  const [confirmarBorrado, setConfirmarBorrado] = useState(false);
  const [importando, setImportando] = useState(false);
  const [importandoShopify, setImportandoShopify] = useState(false);
  // Al buscar: los pedidos de otras asesoras que coinciden, sólo para ver.
  const [ajenos, setAjenos] = useState<Pedido[]>([]);
  const [verAjeno, setVerAjeno] = useState<Pedido | null>(null);
  const [verShalom, setVerShalom] = useState(false);
  const [verSwayp, setVerSwayp] = useState(false);
  const [actualizandoShalom, setActualizandoShalom] = useState(false);
  const [verOlva, setVerOlva] = useState(false);

  // La búsqueda espera a que se deje de escribir: no una consulta por tecla.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setFiltros((f) => (f.texto === texto ? f : { ...f, texto }));
      setPagina(0);
    }, 350);
    return () => window.clearTimeout(t);
  }, [texto]);

  const cambiarFiltro = <K extends keyof Filtros>(clave: K, valor: Filtros[K]) => {
    setFiltros((f) => ({ ...f, [clave]: valor }));
    setPagina(0);
  };

  const recargar = useCallback(() => setRecarga((n) => n + 1), []);

  // Abrir el pedido que pidió el aviso de llamada.
  useEffect(() => {
    if (!abrir) return;
    let vigente = true;
    void (async () => {
      let respuesta = await supabase.from("pedidos").select(COLUMNAS_PEDIDO).eq("workspace_id", workspaceId).eq("codigo", abrir.codigo).maybeSingle();
      if (respuesta.error && /tipo_pedido/.test(respuesta.error.message)) {
        respuesta = await supabase.from("pedidos").select(COLUMNAS_PEDIDO_SIN_TIPO).eq("workspace_id", workspaceId).eq("codigo", abrir.codigo).maybeSingle();
      }
      if (respuesta.error) {
        respuesta = await supabase.from("pedidos").select(COLUMNAS_PEDIDO_BASE).eq("workspace_id", workspaceId).eq("codigo", abrir.codigo).maybeSingle();
      }
      if (vigente && respuesta.data) setAbierto(respuesta.data as unknown as Pedido);
    })();
    return () => {
      vigente = false;
    };
  }, [abrir, supabase, workspaceId]);

  useEffect(() => {
    let vigente = true;
    const cargar = async () => {
      setCargando(true);
      setError(null);
      const termino = terminoDeBusqueda(filtros.texto);
      const desde = pagina * PEDIDOS_POR_PAGINA;

      // Se arma de cero en cada intento: el constructor de la consulta acumula
      // los órdenes, y reusarlo dejaría el orden que falló en el segundo pedido.
      const ordenada = (porNumero: boolean, columnas: string) => {
        let consulta = supabase
          .from("pedidos")
          .select(columnas, { count: "exact" })
          .eq("workspace_id", workspaceId);
        if (termino) consulta = consulta.ilike("busqueda", `%${termino}%`);
        if (filtros.desde) consulta = consulta.gte("fecha_registro", filtros.desde);
        if (filtros.hasta) consulta = consulta.lte("fecha_registro", filtros.hasta);
        if (filtros.estado.length) consulta = consulta.in("estado", filtros.estado);
        else if (!filtros.verDepurados && !termino) consulta = consulta.neq("estado", "DEPURADO");
        if (filtros.asesor.length) consulta = consulta.in("asesor", filtros.asesor);
        if (filtros.destino.length) consulta = consulta.in("destino", filtros.destino);
        if (filtros.canal.length) consulta = consulta.in("canal", filtros.canal);
        if (filtros.envio.length) consulta = consulta.in("envio", filtros.envio);
        if (filtros.courier.length) consulta = consulta.in("courier", filtros.courier);

        // El último código creado, arriba (WED7654, WED7653...). Si todavía no
        // se corrió el SQL que agrega `codigo_num`, se ordena por fecha.
        const conOrden = porNumero
          ? consulta.order("codigo_num", { ascending: false, nullsFirst: false }).order("codigo", { ascending: false })
          : consulta.order("fecha_registro", { ascending: false }).order("codigo", { ascending: false });
        return conOrden.range(desde, desde + PEDIDOS_POR_PAGINA - 1);
      };
      // Si falta correr algún SQL reciente, se pide lo que sí existe.
      let respuesta = await ordenada(true, COLUMNAS_PEDIDO);
      if (respuesta.error && /tipo_pedido/.test(respuesta.error.message)) {
        respuesta = await ordenada(true, COLUMNAS_PEDIDO_SIN_TIPO);
      }
      if (respuesta.error && /prox_llamada_at|guia_swayp|estado_swayp|does not exist/.test(respuesta.error.message)) {
        respuesta = await ordenada(true, COLUMNAS_PEDIDO_BASE);
      }
      if (respuesta.error && /codigo_num/.test(respuesta.error.message)) {
        respuesta = await ordenada(false, COLUMNAS_PEDIDO_BASE);
      }
      const { data, count, error: falla } = respuesta;

      if (!vigente) return;
      if (falla) {
        setError(
          /pedidos/.test(falla.message) && /exist|schema cache/.test(falla.message)
            ? "Todavía no está la tabla de pedidos: falta correr el SQL nuevo en Supabase."
            : falla.message,
        );
        setPedidos([]);
        setTotal(0);
      } else {
        setPedidos((data ?? []) as unknown as Pedido[]);
        setTotal(count ?? 0);
      }
      setCargando(false);
    };
    void cargar();
    return () => {
      vigente = false;
    };
  }, [supabase, workspaceId, filtros, pagina, recarga]);

  // El administrador ya ve todo; el resto busca también en la base entera.
  useEffect(() => {
    const termino = terminoDeBusqueda(filtros.texto);
    let vigente = true;
    void (async () => {
      if (esAdmin || termino.length < 3) {
        if (vigente) setAjenos([]);
        return;
      }
      const { data, error: falla } = await supabase.rpc("buscar_pedidos_de_otros", { ws: workspaceId, termino });
      if (vigente) setAjenos(falla ? [] : ((data ?? []) as Pedido[]));
    })();
    return () => {
      vigente = false;
    };
  }, [supabase, workspaceId, filtros.texto, esAdmin, recarga]);

  const seleccionados = useMemo(() => [...seleccion.values()], [seleccion]);
  const todosMarcados = pedidos.length > 0 && pedidos.every((p) => seleccion.has(p.id));
  const paginas = Math.max(1, Math.ceil(total / PEDIDOS_POR_PAGINA));

  const alternar = (pedido: Pedido) => {
    setSeleccion((actual) => {
      const nueva = new Map(actual);
      if (nueva.has(pedido.id)) nueva.delete(pedido.id);
      else nueva.set(pedido.id, pedido);
      return nueva;
    });
  };

  const alternarPagina = () => {
    setSeleccion((actual) => {
      const nueva = new Map(actual);
      if (todosMarcados) pedidos.forEach((p) => nueva.delete(p.id));
      else pedidos.forEach((p) => nueva.set(p.id, p));
      return nueva;
    });
  };

  const exportarSms = () => {
    const filas = [SMS_COLUMNAS, ...seleccionados.map(filaSms)];
    descargar(`SMS_pedidos_${new Date().toISOString().slice(0, 10)}.csv`, aCsvExcel(filas));
    onNotice(`${seleccionados.length} pedido(s) exportados para SMS.`);
  };

  const borrar = async () => {
    const ids = seleccionados.map((p) => p.id);
    const { error: falla } = await supabase.from("pedidos").delete().in("id", ids);
    setConfirmarBorrado(false);
    if (falla) {
      onNotice(`No se pudieron eliminar: ${falla.message}`);
      return;
    }
    onNotice(`${ids.length} pedido(s) eliminados.`);
    setSeleccion(new Map());
    recargar();
  };

  const hayFiltros =
    texto ||
    Object.entries(filtros).some(([clave, valor]) =>
      clave === "texto" ? false : Array.isArray(valor) ? valor.length > 0 : valor !== FILTROS_VACIOS[clave as keyof Filtros],
    );

  return (
    <div className="space-y-4">
      <IndicadoresPedidos workspaceId={workspaceId} recarga={recarga} onAbrir={(p) => setAbierto(p)} />

      {/* Barra de arriba: buscar y acciones generales */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-neutral-400" />
          <input
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            placeholder="Buscar en toda la base: código, cliente, DNI, celular, tracking…"
            className={`${INPUT_CLASS} h-11 pl-9`}
          />
        </div>
        <button type="button" onClick={recargar} className={`${BOTON_SECUNDARIO} h-11`} title="Actualizar">
          <RefreshCw className={`size-4 ${cargando ? "animate-spin" : ""}`} />
          <span className="hidden sm:inline">Actualizar</span>
        </button>
        {puedeReporte && (
          <button
            type="button"
            disabled={actualizandoShalom}
            onClick={async () => {
              setActualizandoShalom(true);
              const r = await actualizarShalomAhora();
              setActualizandoShalom(false);
              onNotice(r.ok ? r.mensaje : r.error);
              if (r.ok) recargar();
            }}
            className={`${BOTON_SECUNDARIO} h-11`}
            title="Trae de Shalom PRO el estado de los envíos (se hace solo cada 12 horas)"
          >
            <Truck className={`size-4 ${actualizandoShalom ? "animate-pulse" : ""}`} />
            <span className="hidden sm:inline">Actualizar Shalom</span>
          </button>
        )}
        {esAdmin && (
          <button type="button" onClick={() => setImportando(true)} className={`${BOTON_SECUNDARIO} h-11`}>
            <FileSpreadsheet className="size-4" />
            <span className="hidden sm:inline">Importar planilla</span>
          </button>
        )}
        {esAdmin && (
          <button type="button" onClick={() => setImportandoShopify(true)} className={`${BOTON_SECUNDARIO} h-11`} title="Shopify pendientes del CRM anterior">
            <ShoppingBag className="size-4" />
            <span className="hidden sm:inline">Shopify pendientes</span>
          </button>
        )}
        <button type="button" onClick={() => setAbierto("nuevo")} className={`${PRIMARY_BUTTON_CLASS} h-11`}>
          <Plus className="size-4" />
          Nuevo pedido
        </button>
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-xs text-neutral-500">
          Desde
          <input type="date" value={filtros.desde} onChange={(e) => cambiarFiltro("desde", e.target.value)} className={SELECT_CLASS} />
        </label>
        <label className="flex items-center gap-1 text-xs text-neutral-500">
          Hasta
          <input type="date" value={filtros.hasta} onChange={(e) => cambiarFiltro("hasta", e.target.value)} className={SELECT_CLASS} />
        </label>
        <Filtro etiqueta="Estado" valores={filtros.estado} opciones={[...ESTADOS]} onCambio={(v) => cambiarFiltro("estado", v)} />
        <Filtro etiqueta="Asesor" valores={filtros.asesor} opciones={[...OPCIONES.asesor]} onCambio={(v) => cambiarFiltro("asesor", v)} />
        <Filtro etiqueta="Destino" valores={filtros.destino} opciones={[...OPCIONES.destino]} onCambio={(v) => cambiarFiltro("destino", v)} />
        <Filtro etiqueta="Canal" valores={filtros.canal} opciones={[...OPCIONES.canal]} onCambio={(v) => cambiarFiltro("canal", v)} />
        <Filtro etiqueta="Envío" valores={filtros.envio} opciones={[...OPCIONES.envio]} onCambio={(v) => cambiarFiltro("envio", v)} />
        <Filtro etiqueta="Courier" valores={filtros.courier} opciones={[...OPCIONES.courier]} onCambio={(v) => cambiarFiltro("courier", v)} />
        <label className="flex cursor-pointer items-center gap-1.5 text-sm text-neutral-600 dark:text-neutral-300">
          <input
            type="checkbox"
            checked={filtros.verDepurados}
            onChange={(e) => cambiarFiltro("verDepurados", e.target.checked)}
            className="size-4 accent-amber-500"
          />
          Ver depurados
        </label>
        {hayFiltros && (
          <button
            type="button"
            onClick={() => {
              setTexto("");
              setFiltros(FILTROS_VACIOS);
              setPagina(0);
            }}
            className="inline-flex cursor-pointer items-center gap-1 text-sm text-amber-700 hover:underline dark:text-amber-300"
          >
            <X className="size-3.5" /> Limpiar filtros
          </button>
        )}
      </div>

      {/* Acciones sobre la selección */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-[#f9f8f3] px-3 py-2.5 dark:bg-white/5">
        <span className="mr-1 text-sm">
          <b>{seleccion.size}</b> seleccionado(s)
        </span>
        <button type="button" disabled={!seleccion.size} onClick={() => setSeleccion(new Map())} className={BOTON_SECUNDARIO}>
          Limpiar selección
        </button>
        {puedeReporte && (
          <button type="button" disabled={!seleccion.size} onClick={() => setVerReporte(true)} className={BOTON_SECUNDARIO}>
            Generar reporte
          </button>
        )}
        {esAdmin && (
          <button type="button" disabled={!seleccion.size} onClick={() => setVerEtiqueta(true)} className={BOTON_SECUNDARIO}>
            Generar etiqueta
          </button>
        )}
        {/* Asesores: Limpiar selección, los dos despachos y Enviar a Swayp. */}
        {puedeReporte && (
          <button type="button" disabled={!seleccion.size} onClick={exportarSms} className={BOTON_SECUNDARIO}>
            SMS
          </button>
        )}
        <button type="button" disabled={!seleccion.size} onClick={() => setDespacho("lima")} className={BOTON_SECUNDARIO}>
          Despacho Lima
        </button>
        <button type="button" disabled={!seleccion.size} onClick={() => setDespacho("provincia")} className={BOTON_SECUNDARIO}>
          Despacho Provincia
        </button>
        {(puedeReporte || rolVenta === "asesor") && (
          <button type="button" disabled={!seleccion.size} onClick={() => setVerSwayp(true)} className={BOTON_SECUNDARIO}>
            Enviar a Swayp
          </button>
        )}
        {puedeReporte && (
          <button type="button" disabled={!seleccion.size} onClick={() => setVerShalom(true)} className={BOTON_SECUNDARIO}>
            Archivo para Shalom
          </button>
        )}
        {puedeReporte && (
          <button type="button" disabled={!seleccion.size} onClick={() => setVerOlva(true)} className={BOTON_SECUNDARIO}>
            Archivo para Olva
          </button>
        )}
        {esAdmin && (
          <button
            type="button"
            disabled={!seleccion.size}
            onClick={() => setConfirmarBorrado(true)}
            className={`${BOTON_SECUNDARIO} text-red-700 dark:text-red-300`}
          >
            <Trash2 className="size-4" /> Eliminar
          </button>
        )}
      </div>

      {error && (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-500/10 dark:text-red-200">{error}</p>
      )}

      {/* La tabla: con su propio scroll horizontal, la página no se corre. */}
      <div className="overflow-x-auto rounded-2xl border border-[#ddd8c9] bg-white dark:border-white/10 dark:bg-[#1c1811]">
        <table className="w-full min-w-[1200px] text-left text-xs">
          <thead className="bg-[#f4f1e8] text-[11px] uppercase tracking-wide text-neutral-500 dark:bg-white/5">
            <tr>
              <th className="w-9 px-3 py-2.5">
                <input
                  type="checkbox"
                  aria-label="Seleccionar la página"
                  checked={todosMarcados}
                  onChange={alternarPagina}
                  className="size-4 accent-amber-500"
                />
              </th>
              {["Cod", "F. reg", "Monto", "Pedido", "Cliente", "Celular", "DNI", "Tracking", "Estado", "Provincia", "Destino", "Courier", "Asesor"].map((t) => (
                <th key={t} className="whitespace-nowrap px-2 py-2.5 font-semibold">
                  {t}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!cargando && pedidos.length === 0 && (
              <tr>
                <td colSpan={15} className="px-4 py-12 text-center text-sm text-neutral-500">
                  {error ? "—" : hayFiltros ? "No hay pedidos con esos filtros." : "Todavía no hay pedidos. Carga uno o importa tu planilla."}
                </td>
              </tr>
            )}
            {pedidos.map((p) => (
              <tr
                key={p.id}
                onClick={() => setAbierto(p)}
                className={`cursor-pointer border-t border-[#eee9dc] transition-colors hover:bg-amber-50/60 dark:border-white/5 dark:hover:bg-white/5 ${
                  seleccion.has(p.id) ? "bg-amber-50 dark:bg-amber-500/10" : ""
                }`}
              >
                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`Seleccionar ${p.codigo}`}
                    checked={seleccion.has(p.id)}
                    onChange={() => alternar(p)}
                    className="size-4 accent-amber-500"
                  />
                </td>
                <td className="whitespace-nowrap px-2 py-2 font-mono text-neutral-500">{p.codigo}</td>
                <td className="whitespace-nowrap px-2 py-2">{fechaCorta(p.fecha_registro)}</td>
                <td className="whitespace-nowrap px-2 py-2 font-semibold">{soles(p.monto)}</td>
                <td className="max-w-[180px] px-2 py-2 font-medium">{p.pedido}</td>
                <td className="max-w-[220px] px-2 py-2 font-semibold">
                  {p.cliente}
                  {p.es_prueba && <span className="ml-1 rounded bg-neutral-200 px-1 text-[10px] font-normal dark:bg-white/10">prueba</span>}
                  {p.tipo_pedido && p.tipo_pedido !== "VENTA" && (
                    <span className="ml-1 rounded bg-violet-100 px-1 text-[10px] font-semibold text-violet-800 dark:bg-violet-400/15 dark:text-violet-200">
                      {p.tipo_pedido}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-2 py-2 font-mono">{p.celular || "—"}</td>
                <td className="whitespace-nowrap px-2 py-2 font-mono">{p.dni || "—"}</td>
                <td className="whitespace-nowrap px-2 py-2 font-mono">{p.tracking || "—"}</td>
                <td className="px-2 py-2">
                  <EstadoUnico pedido={p} />
                </td>
                <td className="whitespace-nowrap px-2 py-2">{p.provincia || "—"}</td>
                <td className="whitespace-nowrap px-2 py-2">{p.destino || "—"}</td>
                <td className="whitespace-nowrap px-2 py-2">{p.courier || "—"}</td>
                <td className="whitespace-nowrap px-2 py-2">{p.asesor || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Paginación */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-neutral-600 dark:text-neutral-300">
        <span>
          {cargando ? "Cargando…" : `${total.toLocaleString("es-PE")} pedido(s)`}
          {!filtros.verDepurados && !filtros.estado.length && !terminoDeBusqueda(filtros.texto) && " · sin depurados"}
        </span>
        <div className="flex items-center gap-2">
          <button type="button" disabled={pagina === 0 || cargando} onClick={() => setPagina((n) => n - 1)} className={BOTON_SECUNDARIO}>
            <ChevronLeft className="size-4" /> Anterior
          </button>
          <span>
            Página {pagina + 1} de {paginas}
          </span>
          <button
            type="button"
            disabled={pagina + 1 >= paginas || cargando}
            onClick={() => setPagina((n) => n + 1)}
            className={BOTON_SECUNDARIO}
          >
            Siguiente <ChevronRight className="size-4" />
          </button>
        </div>
      </div>

      {ajenos.length > 0 && (
        <section className="rounded-2xl border border-sky-200 bg-sky-50/60 p-3 text-sm dark:border-sky-400/20 dark:bg-sky-400/5">
          <p className="font-semibold">
            También coinciden {ajenos.length === 30 ? "30 o más" : ajenos.length} pedido(s) de otras asesoras{" "}
            <span className="font-normal text-neutral-500">(sólo para ver)</span>
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[640px] text-xs">
              <tbody>
                {ajenos.map((p) => (
                  <tr
                    key={p.id}
                    onClick={() => setVerAjeno(p)}
                    className="cursor-pointer border-b border-sky-100 last:border-0 hover:bg-white dark:border-white/5 dark:hover:bg-white/5"
                  >
                    <td className="whitespace-nowrap px-2 py-2 font-semibold">{p.codigo}</td>
                    <td className="whitespace-nowrap px-2 py-2">{p.fecha_registro}</td>
                    <td className="px-2 py-2">{p.cliente}</td>
                    <td className="whitespace-nowrap px-2 py-2">{p.celular || "—"}</td>
                    <td className="px-2 py-2">
                      <EstadoChip estado={p.estado} />
                    </td>
                    <td className="whitespace-nowrap px-2 py-2">{p.asesor || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {verOlva && <EnvioOlva pedidos={seleccionados} onClose={() => setVerOlva(false)} onNotice={onNotice} />}

      {verSwayp && (
        <EnvioSwayp
          pedidos={seleccionados}
          puedeRegistrar={esAdmin || rolVenta === "encargado" || rolVenta === "asesor"}
          onClose={() => setVerSwayp(false)}
          onNotice={onNotice}
          onRegistrado={recargar}
        />
      )}
      {verShalom && <EnvioShalom pedidos={seleccionados} onClose={() => setVerShalom(false)} onNotice={onNotice} onRegistrado={recargar} />}

      {verAjeno && <PedidoAjeno workspaceId={workspaceId} pedido={verAjeno} onClose={() => setVerAjeno(null)} />}

      {abierto && (
        <PedidoForm
          workspaceId={workspaceId}
          timezone={timezone}
          rolVenta={rolVenta}
          pedido={abierto === "nuevo" ? null : abierto}
          onClose={() => setAbierto(null)}
          onSaved={(mensaje) => {
            setAbierto(null);
            onNotice(mensaje);
            recargar();
          }}
        />
      )}

      {verReporte && <ReporteModal pedidos={seleccionados} onClose={() => setVerReporte(false)} />}

      {despacho && (
        <DespachoModal
          tipo={despacho}
          pedidos={seleccionados}
          onClose={() => setDespacho(null)}
          onNotice={onNotice}
        />
      )}

      {verEtiqueta && (
        <EtiquetaModal
          pedidos={seleccionados}
          onClose={() => setVerEtiqueta(false)}
          onNotice={onNotice}
          onCambio={recargar}
        />
      )}

      {confirmarBorrado && (
        <Modal title="Eliminar pedidos" onClose={() => setConfirmarBorrado(false)}>
          <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-300">
            Vas a eliminar <b>{seleccion.size}</b> pedido(s) con su historial. No se puede deshacer.
          </p>
          <div className="mt-6 flex justify-end gap-2">
            <button type="button" onClick={() => setConfirmarBorrado(false)} className={BOTON_SECUNDARIO}>
              Cancelar
            </button>
            <button
              type="button"
              onClick={borrar}
              className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-500"
            >
              <Trash2 className="size-4" /> Eliminar
            </button>
          </div>
        </Modal>
      )}

      {importandoShopify && (
        <ImportarShopify
          workspaceId={workspaceId}
          onClose={() => setImportandoShopify(false)}
          onTerminado={(mensaje) => {
            onNotice(mensaje);
            recargar();
          }}
        />
      )}

      {importando && (
        <ImportarPedidos
          workspaceId={workspaceId}
          onClose={() => setImportando(false)}
          onTerminado={(mensaje) => {
            onNotice(mensaje);
            recargar();
          }}
        />
      )}
    </div>
  );
}

/**
 * Un filtro de lista con varias opciones a la vez: un botón que abre casillas.
 * Sin ninguna marcada, no filtra.
 */
function Filtro({
  etiqueta,
  valores,
  opciones,
  onCambio,
}: {
  etiqueta: string;
  valores: string[];
  opciones: string[];
  onCambio: (valores: string[]) => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const resumen =
    valores.length === 0 ? "todos" : valores.length === 1 ? valores[0] : `${valores.length} elegidos`;
  const alternar = (opcion: string) =>
    onCambio(valores.includes(opcion) ? valores.filter((v) => v !== opcion) : [...valores, opcion]);

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={abierto}
        onClick={() => setAbierto(!abierto)}
        className={`${SELECT_CLASS} inline-flex cursor-pointer items-center gap-1.5 ${
          valores.length ? "border-amber-400 bg-amber-50 font-semibold dark:bg-amber-400/10" : ""
        }`}
      >
        {etiqueta}: {resumen}
        <ChevronDown className="size-4 text-neutral-400" />
      </button>
      {abierto && (
        <>
          <button type="button" aria-label="Cerrar" className="fixed inset-0 z-20 cursor-default" onClick={() => setAbierto(false)} />
          <div className="absolute left-0 z-30 mt-1 max-h-80 w-60 overflow-auto rounded-xl border border-[#ddd8c9] bg-white p-2 shadow-xl dark:border-white/10 dark:bg-[#1c1811]">
            {opciones.map((opcion) => (
              <label key={opcion} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-white/10">
                <input
                  type="checkbox"
                  checked={valores.includes(opcion)}
                  onChange={() => alternar(opcion)}
                  className="size-4 accent-amber-500"
                />
                {opcion}
              </label>
            ))}
            {valores.length > 0 && (
              <button
                type="button"
                onClick={() => onCambio([])}
                className="mt-1 w-full cursor-pointer rounded-lg px-2 py-1.5 text-left text-sm text-amber-700 hover:bg-neutral-100 dark:text-amber-300 dark:hover:bg-white/10"
              >
                Quitar filtro
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- reporte */

function ReporteModal({ pedidos, onClose }: { pedidos: Pedido[]; onClose: () => void }) {
  const reporte = armarReporte(pedidos);
  const maxAsesor = Math.max(1, ...reporte.porAsesor.map((a) => a.total));
  const maxEstado = Math.max(1, ...reporte.porEstado.map(([, n]) => n));

  return (
    <Modal title="Reporte de la selección" onClose={onClose} ancho="max-w-3xl">
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Dato titulo="Pedidos" valor={reporte.total.toLocaleString("es-PE")} />
        <Dato titulo="Monto total" valor={soles(reporte.monto)} />
        <Dato titulo="Asesor con más" valor={reporte.porAsesor[0] ? `${reporte.porAsesor[0].asesor} (${reporte.porAsesor[0].total})` : "—"} />
      </div>

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-semibold">Por asesor</h3>
          <Barras filas={reporte.porAsesor.map((a) => [a.asesor, a.total])} max={maxAsesor} />
        </div>
        <div>
          <h3 className="mb-2 text-sm font-semibold">Por estado</h3>
          <Barras filas={reporte.porEstado} max={maxEstado} />
        </div>
      </div>

      <h3 className="mb-2 mt-6 text-sm font-semibold">Detalle</h3>
      <div className="max-h-64 overflow-auto rounded-xl border border-[#ddd8c9] dark:border-white/10">
        <table className="w-full text-left text-sm">
          <tbody>
            {reporte.porAsesor.map((a) => (
              <tr key={a.asesor} className="border-t border-[#eee9dc] first:border-t-0 dark:border-white/5">
                <td className="px-3 py-2 font-semibold">{a.asesor}</td>
                <td className="px-3 py-2">{a.total}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {a.estados.map(([estado, n]) => (
                      <span key={estado} className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs dark:bg-white/10">
                        {estado} {n}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

function Dato({ titulo, valor }: { titulo: string; valor: string }) {
  return (
    <div className="rounded-xl bg-white p-3 dark:bg-white/5">
      <p className="text-xs text-neutral-500">{titulo}</p>
      <p className="mt-1 text-lg font-semibold">{valor}</p>
    </div>
  );
}

function Barras({ filas, max }: { filas: [string, number][]; max: number }) {
  return (
    <div className="space-y-1.5">
      {filas.map(([nombre, n]) => (
        <div key={nombre} className="grid grid-cols-[110px_1fr_36px] items-center gap-2 text-xs">
          <span className="truncate" title={nombre}>
            {nombre}
          </span>
          <span className="h-2.5 rounded-full bg-neutral-100 dark:bg-white/10">
            <span className="block h-2.5 rounded-full bg-amber-500" style={{ width: `${Math.max(4, (n / max) * 100)}%` }} />
          </span>
          <span className="text-right font-semibold">{n}</span>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- despacho */

function DespachoModal({
  tipo,
  pedidos,
  onClose,
  onNotice,
}: {
  tipo: Despacho;
  pedidos: Pedido[];
  onClose: () => void;
  onNotice: (message: string) => void;
}) {
  const [conTitulos, setConTitulos] = useState(false);
  const columnas = tipo === "lima" ? DESPACHO_LIMA_COLUMNAS : DESPACHO_PROVINCIA_COLUMNAS;
  const filas = pedidos.map(tipo === "lima" ? filaDespachoLima : filaDespachoProvincia);
  const texto = aTabulado(conTitulos ? [columnas, ...filas] : filas);
  const area = useRef<HTMLTextAreaElement>(null);

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(texto);
      onNotice("Datos copiados. Abre tu hoja de despacho y pega con Ctrl + V.");
    } catch {
      area.current?.select();
      onNotice("No se pudo copiar solo: el texto quedó marcado, cópialo con Ctrl + C.");
    }
  };

  return (
    <Modal title={tipo === "lima" ? "Despacho Lima" : "Despacho Provincia"} onClose={onClose} ancho="max-w-4xl">
      <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-300">
        {pedidos.length} pedido(s). Orden de columnas: <b>{columnas.join(" · ")}</b>
      </p>
      <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" checked={conTitulos} onChange={(e) => setConTitulos(e.target.checked)} className="size-4 accent-amber-500" />
        Incluir los títulos de las columnas
      </label>
      <textarea ref={area} readOnly value={texto} className={`${INPUT_CLASS} mt-3 h-64 font-mono text-xs`} />
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={() =>
            descargar(`despacho_${tipo}_${new Date().toISOString().slice(0, 10)}.csv`, aCsvExcel([columnas, ...filas]))
          }
          className={BOTON_SECUNDARIO}
        >
          <Download className="size-4" /> Bajar CSV
        </button>
        <button type="button" onClick={copiar} className={PRIMARY_BUTTON_CLASS}>
          <ClipboardCopy className="size-4" /> Copiar datos
        </button>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------- etiqueta */

function EtiquetaModal({
  pedidos,
  onClose,
  onNotice,
  onCambio,
}: {
  pedidos: Pedido[];
  onClose: () => void;
  onNotice: (message: string) => void;
  onCambio: () => void;
}) {
  const supabase = getSupabaseBrowser();
  const filas = pedidos.map(filaEtiqueta);
  const faltantes = faltantesDeEtiqueta(pedidos);
  const texto = aTabulado([ETIQUETA_COLUMNAS, ...filas]);
  const abiertos = pedidos.filter((p) => !(ESTADOS_CERRADOS as string[]).includes(p.estado)).map((p) => p.id);
  const [marcando, setMarcando] = useState<"listo" | "marcando" | string>(abiertos.length ? "marcando" : "listo");
  const hecho = useRef(false);

  // Igual que en el CRM anterior: generar la etiqueta pasa los pedidos a
  // EN TRÁNSITO. Los cerrados no se tocan.
  useEffect(() => {
    if (hecho.current || !abiertos.length) return;
    hecho.current = true;
    void (async () => {
      const { error } = await supabase
        .from("pedidos")
        .update({ estado: "EN TRÁNSITO", estado_etiqueta: "GENERADA", fecha_etiqueta: new Date().toISOString() })
        .in("id", abiertos);
      if (error) setMarcando(error.message);
      else {
        setMarcando("listo");
        onCambio();
      }
    })();
    // Corre una sola vez, al abrir la ventana.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(texto);
      onNotice("Etiquetas copiadas.");
    } catch {
      onNotice("No se pudo copiar solo. Selecciona el texto y cópialo con Ctrl + C.");
    }
  };

  return (
    <Modal title="Generar etiqueta" onClose={onClose} ancho="max-w-4xl">
      <p className="mt-3 text-sm">
        {faltantes.length ? (
          <span className="text-amber-700 dark:text-amber-300">
            <b>Revisar:</b> {faltantes.join(" · ")}
          </span>
        ) : (
          <span className="text-emerald-700 dark:text-emerald-300">
            <b>Completo:</b> todos tienen tracking, cliente, DNI, dirección y pedido.
          </span>
        )}
      </p>
      <p className="mt-1 text-xs text-neutral-500">
        {marcando === "marcando"
          ? "Pasando los pedidos a EN TRÁNSITO…"
          : marcando === "listo"
            ? "Los pedidos abiertos quedaron EN TRÁNSITO."
            : `No se pudieron pasar a EN TRÁNSITO: ${marcando}`}
      </p>
      <div className="mt-3 max-h-72 overflow-auto rounded-xl border border-[#ddd8c9] dark:border-white/10">
        <table className="w-full text-left text-xs">
          <thead className="bg-[#f4f1e8] uppercase text-neutral-500 dark:bg-white/5">
            <tr>
              {ETIQUETA_COLUMNAS.map((c) => (
                <th key={c} className="px-2 py-2">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filas.map((fila, i) => (
              <tr key={i} className="border-t border-[#eee9dc] dark:border-white/5">
                {fila.map((valor, j) => (
                  <td key={j} className="px-2 py-1.5">
                    {valor || "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 flex justify-end">
        <button type="button" onClick={copiar} className={PRIMARY_BUTTON_CLASS}>
          <ClipboardCopy className="size-4" /> Copiar etiquetas
        </button>
      </div>
    </Modal>
  );
}
