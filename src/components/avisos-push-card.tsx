"use client";

import { BellRing, CheckCircle2, CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { prepararAvisosPush, type EstadoDeAvisosPush } from "@/app/actions";
import { Copiable } from "@/components/integraciones-panel";
import { Card } from "@/components/ui";

/**
 * Configuración → Avisos push: lo que hace falta para que las notificaciones
 * (próximas llamadas, tareas) lleguen al celular o la compu aunque el CRM esté
 * cerrado. Trae los valores ya generados para copiar a Vercel.
 */
export function AvisosPushCard() {
  const [estado, setEstado] = useState<EstadoDeAvisosPush | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [origen, setOrigen] = useState("https://TU-DIRECCION");

  useEffect(() => {
    let vigente = true;
    void prepararAvisosPush().then((res) => {
      if (!vigente) return;
      if (res.ok) setEstado(res.estado);
      else setError(res.error);
      setOrigen(window.location.origin);
    });
    return () => {
      vigente = false;
    };
  }, []);

  const token = estado?.sugeridas.CRON_SECRET ?? "PEGA-AQUI-TU-CRON_SECRET";
  const sqlDelReloj = `create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'avisos-del-crm',
  '* * * * *',
  $$ select net.http_get(url := '${origen}/api/cron/tareas?token=${token}') $$
);`;

  const faltanVariables = estado && (!estado.llaves || !estado.reloj);

  return (
    <Card className="p-5 sm:p-6">
      <div className="flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-xl bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
          <BellRing className="size-5" />
        </span>
        <div>
          <h2 className="text-lg font-semibold">Avisos push</h2>
          <p className="text-sm text-neutral-500">
            Que la próxima llamada y las tareas avisen en el celular o la compu, aunque el CRM esté cerrado.
          </p>
        </div>
      </div>

      {error && <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-500/10 dark:text-red-200">{error}</p>}
      {!estado && !error && <p className="mt-4 text-sm text-neutral-500">Revisando…</p>}

      {estado && (
        <div className="mt-4 space-y-4 text-sm">
          <ul className="space-y-1">
            <Estado listo={estado.llaves} texto="Llaves de los avisos (VAPID) en Vercel" />
            <Estado listo={estado.reloj} texto="Secreto del reloj (CRON_SECRET) en Vercel" />
          </ul>

          {faltanVariables && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 leading-6 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
              <p className="font-semibold">Paso 1 · Cargar estas variables en Vercel (una sola vez)</p>
              <p className="mt-1 text-xs">
                Vercel → tu proyecto → Settings → Environment Variables. Una por una, tipo <b>Secret</b>, entorno
                Production. Ya están generadas: copia cada valor con su botón y guárdalas también en tu nota.
              </p>
              {Object.entries(estado.sugeridas).map(([nombre, valor]) => (
                <div key={nombre} className="mt-3">
                  <p className="font-mono text-xs font-semibold">{nombre}</p>
                  <Copiable texto={valor ?? ""} />
                </div>
              ))}
              <p className="mt-3 text-xs">
                Después: Deployments → los tres puntos del último → <b>Redeploy</b>. Al volver a esta pantalla, los dos
                puntos de arriba tienen que estar en verde.
              </p>
            </div>
          )}

          <div className="rounded-xl bg-[#f9f8f3] p-4 leading-6 dark:bg-white/5">
            <p className="font-semibold">Paso 2 · Encender el reloj en Supabase (una sola vez)</p>
            <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-300">
              Cada minuto le pregunta al CRM si a alguien le toca llamar. Supabase → SQL Editor → New query → pega esto →
              Run.{" "}
              {!estado.sugeridas.CRON_SECRET && (
                <>
                  Antes, cambia <b>PEGA-AQUI-TU-CRON_SECRET</b> por el valor de CRON_SECRET que guardaste en tu nota.
                </>
              )}
            </p>
            <Copiable texto={sqlDelReloj} />
          </div>

          <div className="rounded-xl bg-[#f9f8f3] p-4 leading-6 dark:bg-white/5">
            <p className="font-semibold">Paso 3 · Cada persona activa los avisos en su equipo</p>
            <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-300">
              En el CRM, la campana de arriba → <b>Activar avisos</b> → Permitir. Se hace en cada celular o compu donde
              quiera recibirlos. En iPhone, primero hay que agregar el CRM a la pantalla de inicio (Compartir → Agregar a
              inicio) y activarlos desde ahí.
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}

function Estado({ listo, texto }: { listo: boolean; texto: string }) {
  return (
    <li className="flex items-center gap-2">
      {listo ? <CheckCircle2 className="size-4 text-emerald-600" /> : <CircleAlert className="size-4 text-amber-600" />}
      {texto}
      <span className={`text-xs ${listo ? "text-emerald-700" : "text-amber-700"}`}>{listo ? "listo" : "falta"}</span>
    </li>
  );
}
