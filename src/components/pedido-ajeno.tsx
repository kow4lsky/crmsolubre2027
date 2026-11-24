"use client";

import { Eye } from "lucide-react";
import { useEffect, useState } from "react";

import { EstadoChip } from "@/components/pedidos-ui";
import { Modal } from "@/components/ui";
import { fechaYHoraDeLima, type Pedido } from "@/lib/pedidos";
import { getSupabaseBrowser } from "@/lib/supabase/browser";

type Movimiento = { id: string; accion: string; usuario: string | null; detalle: string; created_at: string };

/**
 * La ficha de un pedido de otra asesora, sólo para ver: sale cuando se lo
 * encuentra buscando. No se puede cambiar nada desde aquí.
 */
export function PedidoAjeno({ workspaceId, pedido, onClose }: { workspaceId: string; pedido: Pedido; onClose: () => void }) {
  const supabase = getSupabaseBrowser();
  const [historial, setHistorial] = useState<Movimiento[] | null>(null);

  useEffect(() => {
    let vigente = true;
    void (async () => {
      const { data } = await supabase.rpc("historial_de_pedido", { ws: workspaceId, pedido: pedido.id });
      if (vigente) setHistorial((data ?? []) as Movimiento[]);
    })();
    return () => {
      vigente = false;
    };
  }, [supabase, workspaceId, pedido.id]);

  const datos: [string, string | number | null | undefined][] = [
    ["Tipo de pedido", pedido.tipo_pedido && pedido.tipo_pedido !== "VENTA" ? pedido.tipo_pedido : null],
    ["Asesora", pedido.asesor],
    ["Registrado", pedido.fecha_registro],
    ["Cliente", pedido.cliente],
    ["Celular", pedido.celular],
    ["DNI", pedido.dni],
    ["Dirección", pedido.direccion],
    ["Provincia / distrito", [pedido.provincia, pedido.distrito].filter(Boolean).join(" / ")],
    ["Destino", pedido.destino],
    ["Pedido", pedido.pedido],
    ["Monto", pedido.monto != null ? `S/ ${pedido.monto}` : null],
    ["Canal", pedido.canal],
    ["Envío / courier", [pedido.envio, pedido.courier].filter(Boolean).join(" / ")],
    ["Tracking", pedido.tracking],
    ["Clave", pedido.clave],
    ["Nota", pedido.nota],
  ];

  return (
    <Modal title={`${pedido.codigo} · ${pedido.cliente}`} onClose={onClose} ancho="max-w-2xl">
      <p className="mt-3 flex items-center gap-2 rounded-xl bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:bg-sky-400/10 dark:text-sky-100">
        <Eye className="size-4 shrink-0" />
        Es de otra asesora: lo puedes ver, pero no cambiar. Si hay que modificarlo, avísale a ella o al administrador.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <EstadoChip estado={pedido.estado} />
      </div>
      <dl className="mt-3 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
        {datos
          .filter(([, valor]) => valor !== null && valor !== undefined && String(valor).trim() !== "")
          .map(([titulo, valor]) => (
            <div key={titulo} className={titulo === "Nota" || titulo === "Dirección" ? "sm:col-span-2" : ""}>
              <dt className="text-xs text-neutral-500">{titulo}</dt>
              <dd className="whitespace-pre-wrap break-words">{valor}</dd>
            </div>
          ))}
      </dl>
      <h3 className="mt-5 text-sm font-semibold">Historial</h3>
      {historial === null ? (
        <p className="mt-1 text-xs text-neutral-500">Cargando…</p>
      ) : historial.length === 0 ? (
        <p className="mt-1 text-xs text-neutral-500">Sin movimientos registrados.</p>
      ) : (
        <ul className="mt-1 max-h-60 space-y-1.5 overflow-auto text-xs">
          {historial.map((h) => (
            <li key={h.id} className="rounded-lg bg-neutral-50 px-2 py-1.5 dark:bg-white/5">
              <b>{h.accion}</b> · {h.usuario ?? "Sistema"} · {fechaYHoraDeLima(h.created_at)}
              <span className="block text-neutral-600 dark:text-neutral-300">{h.detalle}</span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
