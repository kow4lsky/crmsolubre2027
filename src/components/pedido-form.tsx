"use client";

import { History, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import { BOTON_SECUNDARIO, EstadoChip } from "@/components/pedidos-ui";
import { INPUT_CLASS, Modal, PRIMARY_BUTTON_CLASS } from "@/components/ui";
import { dayKeyInZone } from "@/lib/fechas";
import {
  CANTIDADES_RAPIDAS,
  ESTADOS,
  ESTADOS_CON_ENTREGA_OBLIGATORIA,
  ESTADOS_CON_LLAMADA_OBLIGATORIA,
  OPCIONES,
  OTRA_CANTIDAD,
  TIPOS_DE_PEDIDO,
  aLocalDeLima,
  ajustarEntrega,
  cantidadDeLinea,
  courierPara,
  enviosPara,
  errorDeEntrega,
  faltaParaEstado,
  juntarLineas,
  lineasDe,
  momentoDeLima,
  resumenDeProductos,
  type LineaDeProducto,
  type PedidoItem,
  urlDeSeguimientoSwayp,
  estadosIniciales,
  puedeCambiarEstado,
  type Pedido,
  type RolVenta,
} from "@/lib/pedidos";
import { getSupabaseBrowser } from "@/lib/supabase/browser";

type Campos = Record<
  | "codigo" | "fecha_registro" | "monto" | "cliente" | "direccion" | "dni" | "provincia"
  | "distrito" | "celular" | "destino" | "estado" | "asesor" | "canal" | "envio" | "courier"
  | "costo_envio" | "inventario" | "tracking" | "clave" | "nota" | "adelanto" | "pago_completo"
  | "prox_llamada" | "cerrado_por" | "asignado_a" | "encargado" | "tipo_pedido",
  string
>;

const texto = (valor: unknown) => (valor === null || valor === undefined ? "" : String(valor));

function camposDe(pedido: Pedido | null, hoy: string): Campos {
  return {
    codigo: texto(pedido?.codigo),
    fecha_registro: pedido?.fecha_registro ?? hoy,
    monto: texto(pedido?.monto ?? ""),
    cliente: texto(pedido?.cliente),
    direccion: texto(pedido?.direccion),
    dni: texto(pedido?.dni),
    provincia: texto(pedido?.provincia),
    distrito: texto(pedido?.distrito),
    celular: texto(pedido?.celular),
    destino: texto(pedido?.destino),
    estado: pedido?.estado ?? "VOLVER A LLAMAR",
    asesor: texto(pedido?.asesor),
    canal: texto(pedido?.canal),
    envio: texto(pedido?.envio),
    courier: texto(pedido?.courier),
    costo_envio: texto(pedido?.costo_envio),
    inventario: texto(pedido?.inventario),
    tracking: texto(pedido?.tracking),
    clave: texto(pedido?.clave),
    nota: texto(pedido?.nota),
    adelanto: texto(pedido?.adelanto),
    pago_completo: texto(pedido?.pago_completo),
    // En hora de Lima. Los de la planilla sólo tienen fecha: se proponen a las 9:00.
    prox_llamada: pedido?.prox_llamada_at
      ? aLocalDeLima(pedido.prox_llamada_at)
      : pedido?.prox_llamada
        ? `${pedido.prox_llamada}T09:00`
        : "",
    // "Registrado por": un pedido nuevo lo cerró una asesora salvo que venga de la IA.
    tipo_pedido: pedido?.tipo_pedido ?? "VENTA",
    cerrado_por: pedido ? texto(pedido.cerrado_por) || (pedido.id ? "" : "ASESOR") : "ASESOR",
    asignado_a: texto(pedido?.asignado_a),
    encargado: texto(pedido?.encargado),
  };
}

const numero = (valor: string) => {
  const limpio = valor.replace(",", ".").replace(/[^\d.-]/g, "");
  if (!limpio) return null;
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
};
const nulo = (valor: string) => (valor.trim() ? valor.trim() : null);

type Producto = { nombre: string };
type Movimiento = { id: string; accion: string; usuario: string | null; detalle: string; created_at: string };

export function PedidoForm({
  workspaceId,
  timezone,
  rolVenta,
  pedido,
  inicial = null,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  timezone: string;
  rolVenta: RolVenta;
  pedido: Pedido | null;
  /** Para un pedido nuevo: datos que ya vienen completados (un pendiente de Flujos). */
  inicial?: (Partial<Pedido> & { items?: PedidoItem[] }) | null;
  onClose: () => void;
  /** Con el pedido guardado, para quien necesite vincularlo (Pedidos pendientes). */
  onSaved: (mensaje: string, guardado?: { id: string; codigo: string }) => void;
}) {
  const supabase = getSupabaseBrowser();
  const esAdmin = rolVenta === "admin";
  const nuevo = pedido === null;
  const [campos, setCampos] = useState<Campos>(() =>
    camposDe(pedido ?? ((inicial ?? null) as Pedido | null), dayKeyInZone(new Date(), timezone)),
  );
  const [productos, setProductos] = useState<Producto[]>([]);
  const [lineas, setLineas] = useState<LineaDeProducto[]>([]);
  // Los pedidos de la planilla vieja pueden traer sólo el texto, sin productos.
  const resumenAnterior = pedido?.pedido?.trim() ?? "";
  const [historial, setHistorial] = useState<Movimiento[]>([]);
  const [verHistorial, setVerHistorial] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [lista, items, movimientos] = await Promise.all([
        supabase.from("productos").select("nombre").eq("workspace_id", workspaceId).eq("activo", true).order("orden").order("nombre"),
        pedido
          ? supabase.from("pedido_items").select("producto, cantidad").eq("pedido_id", pedido.id)
          : Promise.resolve({ data: [] as { producto: string; cantidad: number }[] }),
        pedido
          ? supabase
              .from("pedido_historial")
              .select("id, accion, usuario, detalle, created_at")
              .eq("pedido_id", pedido.id)
              .order("created_at", { ascending: false })
              .limit(100)
          : Promise.resolve({ data: [] as Movimiento[] }),
      ]);
      const nombres = new Set((lista.data ?? []).map((p) => p.nombre as string));
      const cargados = (items.data ?? []) as PedidoItem[];
      for (const item of cargados) nombres.add(item.producto);
      setProductos([...nombres].map((nombre) => ({ nombre })));
      // Un pedido nuevo que viene completado trae sus productos.
      setLineas(lineasDe(pedido ? cargados : (inicial?.items ?? [])));
      setHistorial((movimientos.data ?? []) as Movimiento[]);
    })();
  }, [supabase, workspaceId, pedido, inicial]);

  const cambiar = (clave: keyof Campos, valor: string) => setCampos((c) => ({ ...c, [clave]: valor }));

  // Inventario → envío → courier: al cambiar uno, los otros se acomodan solos.
  const cambiarEntrega = (cambio: { inventario?: string; envio?: string }) =>
    setCampos((c) => ({ ...c, ...ajustarEntrega({ inventario: c.inventario, envio: c.envio, courier: c.courier, ...cambio }) }));
  const opcionesDeCourier = courierPara(campos.inventario, campos.envio);
  const entregaObligatoria = (ESTADOS_CON_ENTREGA_OBLIGATORIA as string[]).includes(campos.estado);
  const llamadaObligatoria = (ESTADOS_CON_LLAMADA_OBLIGATORIA as string[]).includes(campos.estado);

  const itemsElegidos = juntarLineas(lineas);
  // Sin productos cargados, un pedido viejo conserva el texto que traía.
  const resumen = itemsElegidos.length ? resumenDeProductos(itemsElegidos) : resumenAnterior;

  const cambiarLinea = (indice: number, cambio: Partial<LineaDeProducto>) =>
    setLineas((actuales) => actuales.map((linea, i) => (i === indice ? { ...linea, ...cambio } : linea)));
  const agregarLinea = () => setLineas((actuales) => [...actuales, { producto: "", cantidad: "1", otra: "" }]);
  const quitarLinea = (indice: number) => setLineas((actuales) => actuales.filter((_, i) => i !== indice));

  const estadoOriginal = pedido?.estado ?? null;
  const necesitaPermiso = !nuevo && estadoOriginal !== null && !puedeCambiarEstado(rolVenta, estadoOriginal, campos.estado);
  const opcionesDeEstado = nuevo ? estadosIniciales(rolVenta) : [...ESTADOS];

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!campos.cliente.trim()) return setError("Falta el nombre del cliente.");
    const celular = campos.celular.replace(/\D/g, "");
    if (celular && celular.length !== 9) return setError("El celular tiene que tener 9 dígitos.");
    const dni = campos.dni.replace(/\D/g, "");
    if (dni && (dni.length < 8 || dni.length > 11)) return setError("El DNI o RUC tiene que tener entre 8 y 11 dígitos.");
    const incompleta = lineas.findIndex((linea) => !linea.producto || cantidadDeLinea(linea) === null);
    if (incompleta > -1) {
      const linea = lineas[incompleta];
      return setError(
        !linea.producto
          ? `Elige el producto del renglón ${incompleta + 1}, o quítalo.`
          : `Escribe la cantidad de ${linea.producto} (un número entero mayor a cero).`,
      );
    }
    if (!itemsElegidos.length && !resumenAnterior) return setError("Añade al menos un producto.");
    if (necesitaPermiso && !motivo.trim()) {
      return setError("Cuenta por qué quieres cambiar el estado: el administrador lo va a leer para aprobarlo.");
    }

    // El courier fijo se guarda aunque el pedido viniera de la planilla con otro.
    const courierFinal = opcionesDeCourier.fijo ?? campos.courier;
    const malEntrega = errorDeEntrega({ inventario: campos.inventario, envio: campos.envio, courier: courierFinal });
    if (malEntrega) return setError(malEntrega);
    // Se mira el estado que se pide, aunque necesite autorización: al aprobarse
    // tiene que llegar completo.
    const falta = faltaParaEstado({
      estado: campos.estado,
      celular,
      destino: campos.destino,
      inventario: campos.inventario,
      envio: campos.envio,
      courier: courierFinal,
      proxLlamada: campos.prox_llamada,
    });
    if (falta) return setError(falta);

    const datos: Record<string, unknown> = {
      fecha_registro: campos.fecha_registro || dayKeyInZone(new Date(), timezone),
      monto: numero(campos.monto) ?? 0,
      pedido: resumen,
      cliente: campos.cliente.trim(),
      direccion: nulo(campos.direccion),
      dni: dni || null,
      provincia: nulo(campos.provincia),
      distrito: nulo(campos.distrito),
      celular: celular || null,
      destino: nulo(campos.destino),
      // Sin permiso, el estado no cambia acá: va a la solicitud.
      estado: necesitaPermiso ? estadoOriginal : campos.estado,
      canal: nulo(campos.canal),
      envio: nulo(campos.envio),
      courier: nulo(courierFinal),
      costo_envio: numero(campos.costo_envio),
      inventario: nulo(campos.inventario),
      tracking: nulo(campos.tracking),
      clave: nulo(campos.clave),
      nota: nulo(campos.nota),
      adelanto: numero(campos.adelanto),
      pago_completo: nulo(campos.pago_completo),

      cerrado_por: nulo(campos.cerrado_por),
    };
    // Sólo se manda si no es venta o si cambió: así un pedido común se sigue
    // guardando aunque todavía no se haya corrido el SQL del tipo de pedido.
    if (campos.tipo_pedido !== (pedido?.tipo_pedido ?? "VENTA")) datos.tipo_pedido = campos.tipo_pedido;
    if (esAdmin || rolVenta === "encargado") {
      datos.asesor = nulo(campos.asesor?.toUpperCase() ?? "");
      datos.asignado_a = nulo(campos.asignado_a.toUpperCase());
    }
    if (esAdmin) {
      datos.encargado = nulo(campos.encargado.toUpperCase());
      if (campos.codigo.trim()) datos.codigo = campos.codigo.trim().toUpperCase();
    }

    // La próxima llamada: si cambió, el aviso es para quien la programó.
    const llamadaInicial = camposDe(pedido, "").prox_llamada;
    const cambioLaLlamada = campos.prox_llamada !== llamadaInicial;
    if (cambioLaLlamada) {
      const { data: sesion } = await supabase.auth.getUser();
      datos.prox_llamada = campos.prox_llamada ? campos.prox_llamada.slice(0, 10) : null;
      datos.prox_llamada_at = campos.prox_llamada ? momentoDeLima(campos.prox_llamada) : null;
      datos.recordatorio_de = campos.prox_llamada ? (sesion.user?.id ?? null) : null;
      datos.recordatorio_visto = false;
    }

    setGuardando(true);
    let id = pedido?.id ?? null;
    let codigo = pedido?.codigo ?? "";

    if (nuevo) {
      const { data, error: falla } = await supabase
        .from("pedidos")
        .insert({ ...datos, workspace_id: workspaceId, codigo: (datos.codigo as string) ?? "" })
        .select("id, codigo")
        .single();
      if (falla || !data) {
        setGuardando(false);
        return setError(traducir(falla?.message));
      }
      id = data.id;
      codigo = data.codigo;
    } else {
      const { error: falla } = await supabase.from("pedidos").update(datos).eq("id", pedido.id);
      if (falla) {
        setGuardando(false);
        return setError(traducir(falla.message));
      }
    }

    // Los productos se guardan enteros: lo que quedó en el formulario es lo que lleva.
    const items = itemsElegidos;
    if (id) {
      if (!nuevo) await supabase.from("pedido_items").delete().eq("pedido_id", id);
      if (items.length) {
        const { error: falla } = await supabase
          .from("pedido_items")
          .insert(items.map((item) => ({ ...item, pedido_id: id, workspace_id: workspaceId })));
        if (falla) {
          setGuardando(false);
          return setError(`El pedido se guardó, pero no los productos: ${falla.message}`);
        }
      }
    }

    if (necesitaPermiso && id && estadoOriginal) {
      const { data: sesion } = await supabase.auth.getUser();
      const { error: falla } = await supabase.from("autorizaciones").insert({
        workspace_id: workspaceId,
        pedido_id: id,
        solicitante_id: sesion.user?.id,
        estado_actual: estadoOriginal,
        estado_solicitado: campos.estado,
        motivo: motivo.trim(),
      });
      setGuardando(false);
      if (falla) return setError(`Se guardaron los cambios, pero no la solicitud: ${falla.message}`);
      return onSaved(
        `Pedido ${codigo} guardado. El cambio a ${campos.estado} quedó esperando la aprobación del administrador.`,
        { id, codigo },
      );
    }

    setGuardando(false);
    onSaved(nuevo ? `Pedido ${codigo} creado.` : `Pedido ${codigo} guardado.`, id ? { id, codigo } : undefined);
  };

  const extras = Object.entries(pedido?.extra ?? {}).filter(([, v]) => v !== null && v !== "");

  return (
    <Modal title={nuevo ? "Nuevo pedido" : `Pedido ${pedido.codigo}`} onClose={onClose} ancho="max-w-4xl">
      <form onSubmit={guardar} className="mt-4 space-y-5">
        {!nuevo && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
            <EstadoChip estado={pedido.estado} />
            {pedido.creado_por && <span>Creado por {pedido.creado_por}</span>}
            {pedido.encargado && <span>· Encargado {pedido.encargado}</span>}
            {pedido.es_prueba && <span>· Pedido de prueba</span>}
          </div>
        )}

        <Seccion titulo="Pedido">
          <Campo etiqueta="Código">
            <input
              value={campos.codigo}
              onChange={(e) => cambiar("codigo", e.target.value)}
              disabled={!esAdmin}
              placeholder={nuevo ? "Se asigna solo" : ""}
              className={INPUT_CLASS}
            />
          </Campo>
          <Campo etiqueta="Fecha de registro">
            <input type="date" value={campos.fecha_registro} onChange={(e) => cambiar("fecha_registro", e.target.value)} className={INPUT_CLASS} />
          </Campo>
          <Campo etiqueta="Monto (S/)">
            <input inputMode="decimal" value={campos.monto} onChange={(e) => cambiar("monto", e.target.value)} className={INPUT_CLASS} />
          </Campo>
          <Campo etiqueta="Tipo de pedido">
            <select
              value={campos.tipo_pedido}
              onChange={(e) => cambiar("tipo_pedido", e.target.value)}
              className={`${INPUT_CLASS} ${campos.tipo_pedido !== "VENTA" ? "border-violet-400! bg-violet-50! dark:bg-violet-400/10!" : ""}`}
            >
              {TIPOS_DE_PEDIDO.map((t) => (
                <option key={t} value={t}>
                  {t === "VENTA" ? "Venta" : t === "REPOSICIÓN" ? "Reposición" : "Cambio"}
                </option>
              ))}
            </select>
            {campos.tipo_pedido !== "VENTA" && (
              <span className="mt-1 block text-xs text-violet-700 dark:text-violet-300">
                Sale del almacén igual, pero no cuenta como venta ni como entrega de la asesora.
              </span>
            )}
          </Campo>

        </Seccion>

        <fieldset>
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Productos</legend>
          <div className="space-y-2">
            {lineas.map((linea, i) => {
              // Un producto ya elegido en otro renglón no se ofrece de nuevo.
              const usados = new Set(lineas.filter((_, j) => j !== i).map((l) => l.producto));
              return (
                <div key={i} className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[2fr_1fr_1fr_auto]">
                  <select
                    aria-label={`Producto ${i + 1}`}
                    value={linea.producto}
                    onChange={(e) => cambiarLinea(i, { producto: e.target.value })}
                    className={`${INPUT_CLASS} col-span-2 sm:col-span-1`}
                  >
                    <option value="">Elige un producto…</option>
                    {productos
                      .filter(({ nombre }) => nombre === linea.producto || !usados.has(nombre))
                      .map(({ nombre }) => (
                        <option key={nombre} value={nombre}>
                          {nombre}
                        </option>
                      ))}
                  </select>
                  <select
                    aria-label={`Cantidad ${i + 1}`}
                    value={linea.cantidad}
                    onChange={(e) => cambiarLinea(i, { cantidad: e.target.value, otra: "" })}
                    className={INPUT_CLASS}
                  >
                    {CANTIDADES_RAPIDAS.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                    <option value={OTRA_CANTIDAD}>Otro monto</option>
                  </select>
                  {linea.cantidad === OTRA_CANTIDAD ? (
                    <input
                      aria-label={`Otra cantidad ${i + 1}`}
                      inputMode="numeric"
                      autoFocus
                      value={linea.otra}
                      onChange={(e) => cambiarLinea(i, { otra: e.target.value.replace(/\D/g, "") })}
                      placeholder="Cantidad"
                      className={INPUT_CLASS}
                    />
                  ) : (
                    <span className="hidden sm:block" />
                  )}
                  <button
                    type="button"
                    aria-label={`Quitar producto ${i + 1}`}
                    onClick={() => quitarLinea(i)}
                    className={`${BOTON_SECUNDARIO} h-[46px]`}
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              );
            })}
            <button type="button" onClick={agregarLinea} className={BOTON_SECUNDARIO}>
              <Plus className="size-4" /> Añadir producto
            </button>
          </div>
          <p className="mt-3 rounded-xl bg-white px-3 py-2.5 text-sm dark:bg-white/5">
            <span className="text-neutral-500">Resumen: </span>
            <b>{resumen || "—"}</b>
            {!itemsElegidos.length && resumenAnterior && (
              <span className="ml-1 text-xs text-neutral-500">(de la planilla; se reemplaza al añadir productos)</span>
            )}
          </p>
          <p className="mt-1 text-xs text-neutral-500">
            Sale del inventario cuando el pedido de Lima está ENTREGADO, o el de Provincia pasa a EN TRÁNSITO.
          </p>
        </fieldset>

        <Seccion titulo="Cliente">
          <Campo etiqueta="Cliente *" ancho>
            <input value={campos.cliente} onChange={(e) => cambiar("cliente", e.target.value)} className={INPUT_CLASS} />
          </Campo>
          <Campo etiqueta={`Celular${entregaObligatoria ? " *" : ""}`}>
            <input inputMode="tel" value={campos.celular} onChange={(e) => cambiar("celular", e.target.value)} placeholder="9 dígitos" className={INPUT_CLASS} />
          </Campo>
          <Campo etiqueta="DNI o RUC">
            <input inputMode="numeric" value={campos.dni} onChange={(e) => cambiar("dni", e.target.value)} className={INPUT_CLASS} />
          </Campo>
          <Campo etiqueta="Dirección" ancho>
            <input value={campos.direccion} onChange={(e) => cambiar("direccion", e.target.value)} className={INPUT_CLASS} />
          </Campo>
          <Campo etiqueta="Provincia">
            <input value={campos.provincia} onChange={(e) => cambiar("provincia", e.target.value)} className={INPUT_CLASS} />
          </Campo>
          <Campo etiqueta="Distrito">
            <input value={campos.distrito} onChange={(e) => cambiar("distrito", e.target.value)} className={INPUT_CLASS} />
          </Campo>
          <Campo etiqueta={`Destino${entregaObligatoria ? " *" : ""}`}>
            <Lista valor={campos.destino} opciones={OPCIONES.destino} onCambio={(v) => cambiar("destino", v)} />
          </Campo>
        </Seccion>

        <Seccion titulo="Gestión y entrega">
          <Campo etiqueta="Estado">
            <select value={campos.estado} onChange={(e) => cambiar("estado", e.target.value)} className={INPUT_CLASS}>
              {opcionesDeEstado.map((estado) => (
                <option key={estado} value={estado}>
                  {estado}
                </option>
              ))}
            </select>
          </Campo>
          <Campo etiqueta="Asesor">
            {esAdmin || rolVenta === "encargado" ? (
              <Lista valor={campos.asesor} opciones={OPCIONES.asesor} onCambio={(v) => cambiar("asesor", v)} />
            ) : (
              <input value={campos.asesor || "(tú)"} disabled className={INPUT_CLASS} />
            )}
          </Campo>
          <Campo etiqueta="Canal">
            <Lista valor={campos.canal} opciones={OPCIONES.canal} onCambio={(v) => cambiar("canal", v)} />
          </Campo>
          <Campo etiqueta={`Inventario${entregaObligatoria ? " *" : ""}`}>
            <Lista valor={campos.inventario} opciones={OPCIONES.inventario} onCambio={(v) => cambiarEntrega({ inventario: v })} />
          </Campo>
          <Campo etiqueta={`Envío${entregaObligatoria ? " *" : ""}`}>
            {campos.inventario ? (
              <Lista valor={campos.envio} opciones={enviosPara(campos.inventario)} onCambio={(v) => cambiarEntrega({ envio: v })} />
            ) : (
              <input disabled value="" placeholder="Elige primero el inventario" className={INPUT_CLASS} />
            )}
          </Campo>
          <Campo etiqueta={`Courier${entregaObligatoria ? " *" : ""}`}>
            {opcionesDeCourier.fijo ? (
              // Sale solo y no se cambia: Swayp con SWAYP, Solubre con Indriver.
              <input disabled value={opcionesDeCourier.fijo} className={`${INPUT_CLASS} font-semibold`} />
            ) : opcionesDeCourier.opciones.length ? (
              <Lista valor={campos.courier} opciones={opcionesDeCourier.opciones} onCambio={(v) => cambiar("courier", v)} />
            ) : (
              <input
                disabled
                value={campos.courier}
                placeholder={campos.inventario ? "Elige primero el envío" : "Elige primero el inventario"}
                className={INPUT_CLASS}
              />
            )}
          </Campo>
          <Campo etiqueta="Costo de envío (S/)">
            <input inputMode="decimal" value={campos.costo_envio} onChange={(e) => cambiar("costo_envio", e.target.value)} className={INPUT_CLASS} />
          </Campo>
          <Campo etiqueta={`Próxima llamada (hora de Perú)${llamadaObligatoria ? " *" : ""}`}>
            <input
              type="datetime-local"
              value={campos.prox_llamada}
              onChange={(e) => cambiar("prox_llamada", e.target.value)}
              className={INPUT_CLASS}
            />
            {campos.prox_llamada && (
              <span className="mt-1 block font-normal text-neutral-500">Te aparece un aviso en el CRM a esa hora.</span>
            )}
          </Campo>
          <Campo etiqueta="Tracking">
            <input value={campos.tracking} onChange={(e) => cambiar("tracking", e.target.value)} className={INPUT_CLASS} />
          </Campo>
          <Campo etiqueta="Clave">
            <input value={campos.clave} onChange={(e) => cambiar("clave", e.target.value)} className={INPUT_CLASS} />
          </Campo>
          <Campo etiqueta="Adelanto (S/)">
            <input inputMode="decimal" value={campos.adelanto} onChange={(e) => cambiar("adelanto", e.target.value)} className={INPUT_CLASS} />
          </Campo>
          <Campo etiqueta="Pago completo">
            <input value={campos.pago_completo} onChange={(e) => cambiar("pago_completo", e.target.value)} className={INPUT_CLASS} />
          </Campo>
          <Campo etiqueta="Registrado por (IA o asesora)">
            <Lista valor={campos.cerrado_por} opciones={OPCIONES.cerradoPor} onCambio={(v) => cambiar("cerrado_por", v)} />
          </Campo>
          {(esAdmin || rolVenta === "encargado") && (
            <Campo etiqueta="Asignado a">
              <input value={campos.asignado_a} onChange={(e) => cambiar("asignado_a", e.target.value)} className={INPUT_CLASS} />
            </Campo>
          )}
          {esAdmin && (
            <Campo etiqueta="Encargado">
              <input value={campos.encargado} onChange={(e) => cambiar("encargado", e.target.value)} className={INPUT_CLASS} />
            </Campo>
          )}
          <Campo etiqueta="Nota" ancho>
            <textarea value={campos.nota} onChange={(e) => cambiar("nota", e.target.value)} rows={2} className={INPUT_CLASS} />
          </Campo>
        </Seccion>

        {necesitaPermiso && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-400/30 dark:bg-amber-400/10">
            <p className="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200">
              <ShieldAlert className="size-4" /> Pasar de {estadoOriginal} a {campos.estado} necesita autorización
            </p>
            <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
              Al guardar, el resto de los cambios se aplica y el cambio de estado le llega al administrador para que lo apruebe.
            </p>
            <textarea
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              rows={2}
              placeholder="Motivo: por ejemplo, el motorizado confirmó la entrega"
              className={`${INPUT_CLASS} mt-2`}
            />
          </div>
        )}

        {extras.length > 0 && (
          <details className="rounded-xl bg-white p-3 text-sm dark:bg-white/5">
            <summary className="cursor-pointer font-semibold">Otros datos de la planilla ({extras.length})</summary>
            <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
              {extras.map(([clave, valor]) => (
                <div key={clave} className="flex gap-2">
                  <dt className="shrink-0 text-neutral-500">{clave}:</dt>
                  <dd className="break-words">{String(valor)}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}

        {!nuevo && pedido.guia_swayp && <SeguimientoSwayp pedido={pedido} timezone={timezone} />}

        {!nuevo && (
          <div>
            <button type="button" onClick={() => setVerHistorial(!verHistorial)} className={BOTON_SECUNDARIO}>
              <History className="size-4" /> {verHistorial ? "Ocultar historial" : `Ver historial (${historial.length})`}
            </button>
            {verHistorial && (
              <ol className="mt-3 max-h-60 space-y-2 overflow-auto text-xs">
                {historial.length === 0 && <li className="text-neutral-500">Sin cambios registrados desde que está en este CRM.</li>}
                {historial.map((m) => (
                  <li key={m.id} className="rounded-lg bg-white p-2 dark:bg-white/5">
                    <span className="font-semibold">{m.accion}</span> · {m.usuario ?? "sistema"} ·{" "}
                    {new Date(m.created_at).toLocaleString("es-PE", { timeZone: timezone })}
                    <p className="mt-0.5 break-words text-neutral-600 dark:text-neutral-300">{m.detalle}</p>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}

        {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-500/10 dark:text-red-200">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={BOTON_SECUNDARIO}>
            Cancelar
          </button>
          <button type="submit" disabled={guardando} className={PRIMARY_BUTTON_CLASS}>
            {guardando ? "Guardando…" : necesitaPermiso ? "Guardar y pedir autorización" : nuevo ? "Crear pedido" : "Guardar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Los errores de la base, dichos para una persona. */
function traducir(mensaje: string | undefined): string {
  if (!mensaje) return "No se pudo guardar. Prueba de nuevo.";
  if (/duplicate key|pedidos_workspace_id_codigo_key/.test(mensaje)) return "Ya existe un pedido con ese código.";
  return mensaje;
}

function Seccion({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">{titulo}</legend>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
    </fieldset>
  );
}

function Campo({ etiqueta, ancho = false, children }: { etiqueta: string; ancho?: boolean; children: React.ReactNode }) {
  return (
    <label className={`block text-xs font-medium text-neutral-600 dark:text-neutral-300 ${ancho ? "sm:col-span-2" : ""}`}>
      <span className="mb-1 block">{etiqueta}</span>
      {children}
    </label>
  );
}

function Lista({ valor, opciones, onCambio }: { valor: string; opciones: readonly string[]; onCambio: (v: string) => void }) {
  // Si el pedido trae un valor que no está en la lista (de la planilla vieja), se muestra igual.
  const todas = valor && !opciones.includes(valor) ? [valor, ...opciones] : opciones;
  return (
    <select value={valor} onChange={(e) => onCambio(e.target.value)} className={INPUT_CLASS}>
      <option value="">—</option>
      {todas.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

type EventoDeEnvio = { id: string; estado: string | null; comentario: string | null; created_at: string };

/** La guía de Swayp (sólo lectura), su link de seguimiento y los avisos que llegaron. */
function SeguimientoSwayp({ pedido, timezone }: { pedido: Pedido; timezone: string }) {
  const supabase = getSupabaseBrowser();
  const [eventos, setEventos] = useState<EventoDeEnvio[] | null>(null);

  useEffect(() => {
    let vigente = true;
    void (async () => {
      const { data } = await supabase
        .from("envio_eventos")
        .select("id, estado, comentario, created_at")
        .eq("pedido_id", pedido.id)
        .order("created_at", { ascending: false })
        .limit(50);
      if (vigente) setEventos((data ?? []) as EventoDeEnvio[]);
    })();
    return () => {
      vigente = false;
    };
  }, [supabase, pedido.id]);

  const guia = pedido.guia_swayp ?? "";
  return (
    <div className="rounded-xl bg-white p-3 text-sm dark:bg-white/5">
      <p className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Guía Swayp</span>
        <span className="font-mono">{guia}</span>
        {pedido.estado_swayp && <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs dark:bg-white/10">{pedido.estado_swayp}</span>}
        <a href={urlDeSeguimientoSwayp(guia)} target="_blank" rel="noreferrer" className="text-xs font-semibold text-amber-700 underline dark:text-amber-300">
          Ver seguimiento
        </a>
      </p>
      {eventos && eventos.length > 0 && (
        <ol className="mt-2 space-y-1 text-xs text-neutral-600 dark:text-neutral-300">
          {eventos.map((e) => (
            <li key={e.id}>
              <b>{e.estado ?? "—"}</b> · {new Date(e.created_at).toLocaleString("es-PE", { timeZone: timezone })}
              {e.comentario ? ` · ${e.comentario}` : ""}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
