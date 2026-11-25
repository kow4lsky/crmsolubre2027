"use client";

import { ScrollText } from "lucide-react";
import { useEffect, useState } from "react";

import { BOTON_SECUNDARIO } from "@/components/pedidos-ui";
import { Card } from "@/components/ui";
import { getSupabaseBrowser } from "@/lib/supabase/browser";

type Fila = { id: string; servicio: string; nivel: "info" | "aviso" | "error"; mensaje: string; created_at: string };

const COLOR: Record<Fila["nivel"], string> = {
  info: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  aviso: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  error: "bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300",
};

/**
 * Lo que pasó con las conexiones (Swayp, Shalom): sesiones vencidas, avisos
 * sin pedido, registros masivos… con fecha y hora, como prueba ante cualquier
 * reclamo. Lo ven el administrador y el encargado.
 */
export function RegistroConexionesCard({ timezone }: { timezone: string }) {
  const supabase = getSupabaseBrowser();
  const [filas, setFilas] = useState<Fila[] | null>(null);
  const [falta, setFalta] = useState(false);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    let vigente = true;
    void (async () => {
      const { data, error } = await supabase
        .from("conexion_registro")
        .select("id, servicio, nivel, mensaje, created_at")
        .order("created_at", { ascending: false })
        .limit(40);
      if (!vigente) return;
      if (error) setFalta(true);
      else setFilas((data ?? []) as Fila[]);
    })();
    return () => {
      vigente = false;
    };
  }, [supabase, recarga]);

  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold">
          <ScrollText className="size-5" /> Registro de las conexiones
        </h2>
        <button type="button" onClick={() => setRecarga((n) => n + 1)} className={BOTON_SECUNDARIO}>
          Actualizar
        </button>
      </div>
      <p className="mt-1 text-sm text-neutral-500">Lo que pasó con Swayp y Shalom: problemas, avisos y registros, con fecha y hora.</p>
      {falta && <p className="mt-3 text-sm text-neutral-500">Falta correr el SQL 202612090001_estado_unico.sql en Supabase.</p>}
      {filas && filas.length === 0 && <p className="mt-3 text-sm text-neutral-500">Todavía no hay nada anotado.</p>}
      {filas && filas.length > 0 && (
        <ol className="mt-3 max-h-80 space-y-2 overflow-auto text-sm">
          {filas.map((f) => (
            <li key={f.id} className="rounded-xl bg-[#f9f8f3] p-3 dark:bg-white/5">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className={`rounded-full px-2 py-0.5 font-semibold ${COLOR[f.nivel] ?? COLOR.error}`}>{f.servicio}</span>
                <span className="text-neutral-500">{new Date(f.created_at).toLocaleString("es-PE", { timeZone: timezone })}</span>
              </div>
              <p className="mt-1 break-words">{f.mensaje}</p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
