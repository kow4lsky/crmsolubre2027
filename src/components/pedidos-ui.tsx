"use client";

import { ESTADO_COLORES, esEstado, estadoVisible } from "@/lib/pedidos";

/** Las piezas chicas que comparten la tabla de pedidos y sus ventanas. */

export const BOTON_SECUNDARIO =
  "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-[#ddd8c9] bg-[#f9f8f3] px-3 py-2 text-sm font-medium transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10";

/** Baja un archivo generado en el navegador. */
export function descargar(nombre: string, contenido: string, tipo = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([contenido], { type: tipo }));
  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = nombre;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  URL.revokeObjectURL(url);
}

export function EstadoChip({ estado }: { estado: string }) {
  const color = esEstado(estado) ? ESTADO_COLORES[estado] : ESTADO_COLORES.NC;
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${color}`}>
      {estado}
    </span>
  );
}

/**
 * La única columna de estado: el del courier tal cual (con su nombre chiquito)
 * cuando el pedido ya salió, o el del CRM mientras se gestiona.
 */
export function EstadoUnico({ pedido }: { pedido: Parameters<typeof estadoVisible>[0] }) {
  const v = estadoVisible(pedido);
  return (
    <span
      title={v.courier ? `Estado de ${v.courier === "SWAYP" ? "Swayp" : "Shalom"}. En el CRM: ${pedido.estado}` : undefined}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${v.color}`}
    >
      {v.courier && <span className="text-[9px] font-bold tracking-wide opacity-70">{v.courier}</span>}
      {v.courier ? v.texto.toUpperCase() : v.texto}
    </span>
  );
}
