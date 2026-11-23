"use client";

import { Phone, X } from "lucide-react";
import { useEffect, useState } from "react";

import { BOTON_SECUNDARIO } from "@/components/pedidos-ui";
import { PRIMARY_BUTTON_CLASS } from "@/components/ui";
import { fechaYHoraDeLima } from "@/lib/pedidos";
import { getSupabaseBrowser } from "@/lib/supabase/browser";

type Llamada = { id: string; codigo: string; cliente: string; celular: string | null; prox_llamada_at: string };

/** Cada cuánto se revisa si le toca llamar a alguien. */
const CADA_MS = 60_000;

/**
 * El aviso de "próxima llamada": a la hora que programó, cada persona ve sus
 * llamadas pendientes. Es de quien la programó, no de todo el equipo.
 */
export function RecordatoriosDeLlamada({ userId, onAbrir }: { userId: string; onAbrir: (codigo: string) => void }) {
  const supabase = getSupabaseBrowser();
  const [llamadas, setLlamadas] = useState<Llamada[]>([]);
  const [plegado, setPlegado] = useState(false);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    let vigente = true;
    const revisar = async () => {
      const { data, error } = await supabase
        .from("pedidos")
        .select("id, codigo, cliente, celular, prox_llamada_at")
        .eq("recordatorio_de", userId)
        .eq("recordatorio_visto", false)
        .lte("prox_llamada_at", new Date().toISOString())
        .order("prox_llamada_at", { ascending: true })
        .limit(10);
      // Sin el SQL de recordatorios la consulta falla: no hay nada que avisar.
      if (!vigente || error) return;
      setLlamadas((data ?? []) as Llamada[]);
    };
    void revisar();
    const reloj = window.setInterval(() => void revisar(), CADA_MS);
    return () => {
      vigente = false;
      window.clearInterval(reloj);
    };
  }, [supabase, userId, recarga]);

  if (!llamadas.length) return null;

  const listo = async (id: string) => {
    setLlamadas((actuales) => actuales.filter((l) => l.id !== id));
    await supabase.from("pedidos").update({ recordatorio_visto: true }).eq("id", id);
    setRecarga((n) => n + 1);
  };

  if (plegado) {
    return (
      <button
        type="button"
        onClick={() => setPlegado(false)}
        className="fixed bottom-5 right-5 z-40 inline-flex cursor-pointer items-center gap-2 rounded-full bg-amber-500 px-4 py-3 text-sm font-semibold text-neutral-950 shadow-xl"
      >
        <Phone className="size-4" /> {llamadas.length} llamada(s) pendiente(s)
      </button>
    );
  }

  return (
    <div
      role="alert"
      className="fixed bottom-5 right-5 z-40 w-[min(380px,calc(100vw-2.5rem))] rounded-2xl border border-amber-300 bg-[#f9f8f3] p-4 shadow-2xl dark:border-amber-400/30 dark:bg-[#1c1811]"
    >
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-2 font-semibold">
          <Phone className="size-4 text-amber-600" /> Hora de llamar
        </p>
        <button
          type="button"
          aria-label="Minimizar"
          onClick={() => setPlegado(true)}
          className="cursor-pointer rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-white/10"
        >
          <X className="size-4" />
        </button>
      </div>
      <ul className="mt-3 max-h-72 space-y-2 overflow-auto">
        {llamadas.map((l) => (
          <li key={l.id} className="rounded-xl bg-white p-3 text-sm dark:bg-white/5">
            <p className="font-semibold">{l.cliente}</p>
            <p className="text-xs text-neutral-500">
              {l.codigo} · {l.celular ? <a href={`tel:${l.celular}`} className="underline">{l.celular}</a> : "sin celular"} ·{" "}
              {fechaYHoraDeLima(l.prox_llamada_at)}
            </p>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => onAbrir(l.codigo)} className={`${PRIMARY_BUTTON_CLASS} px-3 py-1.5`}>
                Abrir pedido
              </button>
              <button type="button" onClick={() => void listo(l.id)} className={BOTON_SECUNDARIO}>
                Ya llamé
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
