"use client";

import { useEffect, useState } from "react";

import { cargarEquipoDeVenta, guardarMiembroDeVenta, type MiembroDeVenta } from "@/app/actions";
import { INPUT_CLASS, PRIMARY_BUTTON_CLASS } from "@/components/ui";
import { ROL_VENTA_LABELS, ROLES_VENTA, type RolVenta } from "@/lib/pedidos";

const QUE_PUEDE: Record<RolVenta, string> = {
  admin: "Ve y puede todo.",
  encargado: "Ve sus pedidos y los CONFIRMADOS sin encargado. Prepara despachos.",
  asesor: "Ve sólo los pedidos que creó o tiene asignados.",
  asesor_temp: "Como asesor, pero sus pedidos son de prueba: no cuentan y tiene un máximo de 10 por día.",
};

export function UsuariosPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [miembros, setMiembros] = useState<MiembroDeVenta[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void cargarEquipoDeVenta().then((res) => {
      if (res.ok) setMiembros(res.miembros);
      else setError(res.error);
    });
  }, []);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="rounded-2xl bg-[#f9f8f3] p-4 text-sm text-neutral-600 dark:bg-white/5 dark:text-neutral-300">
        <p>
          <b>Para sumar a alguien:</b> creale la cuenta en Supabase → Authentication → Users → Add user (con{" "}
          <i>Auto Confirm User</i>). Cuando entre por primera vez aparece acá como <b>Asesor</b>; elegí su rol y su alias.
        </p>
        <p className="mt-2">
          El <b>alias</b> es el nombre con el que figura en los pedidos (MILTON, NATHALY…). Con eso el CRM sabe cuáles son
          los suyos, también los que vinieron de la planilla.
        </p>
      </div>

      {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-500/10 dark:text-red-200">{error}</p>}
      {!miembros && !error && <p className="text-sm text-neutral-500">Cargando…</p>}

      <ul className="space-y-3">
        {miembros?.map((m) => (
          <FilaMiembro key={m.userId} miembro={m} onNotice={onNotice} />
        ))}
      </ul>
    </div>
  );
}

function FilaMiembro({ miembro, onNotice }: { miembro: MiembroDeVenta; onNotice: (message: string) => void }) {
  const [rol, setRol] = useState<RolVenta>(miembro.rolVenta);
  const [alias, setAlias] = useState(miembro.alias ?? "");
  // Lo último guardado: con eso se sabe si hay cambios sin guardar.
  const [guardado, setGuardado] = useState({ rol: miembro.rolVenta, alias: miembro.alias ?? "" });
  const [guardando, setGuardando] = useState(false);
  const cambiado = rol !== guardado.rol || alias.trim().toUpperCase() !== guardado.alias;

  const guardar = async () => {
    setGuardando(true);
    const res = await guardarMiembroDeVenta({ userId: miembro.userId, rolVenta: rol, alias });
    setGuardando(false);
    if (!res.ok) return onNotice(res.error);
    setGuardado({ rol, alias: alias.trim().toUpperCase() });
    onNotice(`Guardado: ${miembro.email} ahora es ${ROL_VENTA_LABELS[rol]}.`);
  };

  return (
    <li className="rounded-2xl bg-[#f9f8f3] p-4 dark:bg-white/5">
      <p className="font-semibold">
        {miembro.email}
        {miembro.principal && <span className="ml-2 text-xs font-normal text-neutral-500">(cuenta principal)</span>}
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
          <span className="mb-1 block">Rol</span>
          <select
            value={rol}
            disabled={miembro.principal}
            onChange={(e) => setRol(e.target.value as RolVenta)}
            className={INPUT_CLASS}
          >
            {ROLES_VENTA.map((r) => (
              <option key={r} value={r}>
                {ROL_VENTA_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
          <span className="mb-1 block">Alias</span>
          <input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="MILTON" className={`${INPUT_CLASS} uppercase`} />
        </label>
        <button type="button" disabled={!cambiado || guardando} onClick={() => void guardar()} className={`${PRIMARY_BUTTON_CLASS} h-[46px]`}>
          {guardando ? "Guardando…" : "Guardar"}
        </button>
      </div>
      <p className="mt-2 text-xs text-neutral-500">{QUE_PUEDE[rol]}</p>
    </li>
  );
}
