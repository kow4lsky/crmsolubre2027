"use client";

import { Eye, EyeOff, UserPlus } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import {
  cargarEquipoDeVenta,
  crearUsuarioDelEquipo,
  guardarMiembroDeVenta,
  guardarSeccionesDeMiembro,
  type MiembroDeVenta,
} from "@/app/actions";
import { BOTON_SECUNDARIO } from "@/components/pedidos-ui";
import { Card, INPUT_CLASS, PRIMARY_BUTTON_CLASS } from "@/components/ui";
import { MIN_PASSWORD_CHARS } from "@/lib/password";
import { ROL_VENTA_LABELS, ROLES_VENTA, type RolVenta } from "@/lib/pedidos";
import { SECCIONES_ASIGNABLES, seccionesPorDefecto, type SeccionAsignable } from "@/lib/secciones";

const QUE_PUEDE: Record<RolVenta, string> = {
  admin: "Ve y puede todo, también Configuración y Base de datos.",
  encargado: "Ve sus pedidos y los CONFIRMADOS sin encargado. Prepara despachos.",
  asesor: "Ve solo los pedidos que creó o tiene asignados.",
  asesor_temp: "Como asesor, pero sus pedidos son de prueba: no cuentan y tiene un máximo de 10 por día.",
};

/** Usuarios del equipo: alta con correo y contraseña, rol, alias y secciones. */
export function UsuariosPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [miembros, setMiembros] = useState<MiembroDeVenta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agregando, setAgregando] = useState(false);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    let vigente = true;
    void cargarEquipoDeVenta().then((res) => {
      if (!vigente) return;
      if (res.ok) {
        setMiembros(res.miembros);
        setError(null);
      } else setError(res.error);
    });
    return () => {
      vigente = false;
    };
  }, [recarga]);

  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Usuarios</h2>
          <p className="text-sm text-neutral-500">Quién entra al CRM, con qué rol y qué secciones ve.</p>
        </div>
        {!agregando && (
          <button type="button" onClick={() => setAgregando(true)} className={PRIMARY_BUTTON_CLASS}>
            <UserPlus className="size-4" /> Agregar usuario
          </button>
        )}
      </div>

      {agregando && (
        <NuevoUsuario
          onCancelar={() => setAgregando(false)}
          onCreado={(mensaje) => {
            setAgregando(false);
            onNotice(mensaje);
            setRecarga((n) => n + 1);
          }}
        />
      )}

      {error && <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-500/10 dark:text-red-200">{error}</p>}
      {!miembros && !error && <p className="mt-4 text-sm text-neutral-500">Cargando…</p>}

      <ul className="mt-5 space-y-3">
        {miembros?.map((m) => (
          <FilaMiembro key={m.userId} miembro={m} onNotice={onNotice} />
        ))}
      </ul>

      <p className="mt-4 text-xs text-neutral-500">
        Ocultar una sección la saca del menú de esa persona. Lo que cada uno puede ver de los pedidos lo sigue decidiendo su
        rol: un asesor nunca ve los pedidos de otro, aunque tenga la sección Pedidos.
      </p>
    </Card>
  );
}

function CasillasDeSecciones({
  elegidas,
  onCambio,
  deshabilitado = false,
}: {
  elegidas: SeccionAsignable[];
  onCambio: (nuevas: SeccionAsignable[]) => void;
  deshabilitado?: boolean;
}) {
  const alternar = (nombre: SeccionAsignable) =>
    onCambio(elegidas.includes(nombre) ? elegidas.filter((s) => s !== nombre) : [...elegidas, nombre]);
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {SECCIONES_ASIGNABLES.map(({ nombre, detalle }) => (
        <label
          key={nombre}
          className={`flex cursor-pointer items-start gap-2 rounded-xl border border-[#ddd8c9] bg-white p-2.5 text-sm dark:border-white/10 dark:bg-white/5 ${
            deshabilitado ? "cursor-not-allowed opacity-60" : ""
          }`}
        >
          <input
            type="checkbox"
            disabled={deshabilitado}
            checked={deshabilitado || elegidas.includes(nombre)}
            onChange={() => alternar(nombre)}
            className="mt-0.5 size-4 accent-amber-500"
          />
          <span>
            <span className="font-semibold">{nombre}</span>
            <span className="block text-xs text-neutral-500">{detalle}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function NuevoUsuario({ onCancelar, onCreado }: { onCancelar: () => void; onCreado: (mensaje: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [verPassword, setVerPassword] = useState(false);
  const [rol, setRol] = useState<RolVenta>("asesor");
  const [alias, setAlias] = useState("");
  const [secciones, setSecciones] = useState<SeccionAsignable[]>(seccionesPorDefecto("asesor"));
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const crear = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setGuardando(true);
    const res = await crearUsuarioDelEquipo({ email, password, rolVenta: rol, alias, secciones });
    setGuardando(false);
    if (!res.ok) return setError(res.error);
    onCreado(res.warning ?? "Usuario creado.");
  };

  return (
    <form onSubmit={crear} className="mt-5 space-y-4 rounded-2xl border border-amber-300 bg-amber-50/50 p-4 dark:border-amber-400/30 dark:bg-amber-400/5">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
          <span className="mb-1 block">Correo</span>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="nombre@correo.com" className={INPUT_CLASS} />
        </label>
        <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
          <span className="mb-1 block">Contraseña (mínimo {MIN_PASSWORD_CHARS} caracteres)</span>
          <span className="relative block">
            <input
              type={verPassword ? "text" : "password"}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              className={`${INPUT_CLASS} pr-11`}
            />
            <button
              type="button"
              aria-label={verPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
              onClick={() => setVerPassword(!verPassword)}
              className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-white/10"
            >
              {verPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </span>
        </label>
        <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
          <span className="mb-1 block">Rol</span>
          <select
            value={rol}
            onChange={(e) => {
              const nuevo = e.target.value as RolVenta;
              setRol(nuevo);
              setSecciones(seccionesPorDefecto(nuevo));
            }}
            className={INPUT_CLASS}
          >
            {ROLES_VENTA.map((r) => (
              <option key={r} value={r}>
                {ROL_VENTA_LABELS[r]}
              </option>
            ))}
          </select>
          <span className="mt-1 block font-normal text-neutral-500">{QUE_PUEDE[rol]}</span>
        </label>
        <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
          <span className="mb-1 block">Alias (cómo figura en los pedidos)</span>
          <input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="NATHALY" className={`${INPUT_CLASS} uppercase`} />
        </label>
      </div>

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Secciones que ve</p>
        <CasillasDeSecciones elegidas={secciones} onCambio={setSecciones} deshabilitado={rol === "admin"} />
        {rol === "admin" && <p className="mt-2 text-xs text-neutral-500">Un administrador ve todas las secciones.</p>}
      </div>

      {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-500/10 dark:text-red-200">{error}</p>}

      <p className="text-xs text-neutral-500">
        Pásale el correo y la contraseña por un medio seguro. Puede cambiar su contraseña desde su cuenta, arriba a la derecha.
      </p>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancelar} className={BOTON_SECUNDARIO}>
          Cancelar
        </button>
        <button type="submit" disabled={guardando} className={PRIMARY_BUTTON_CLASS}>
          {guardando ? "Creando…" : "Crear usuario"}
        </button>
      </div>
    </form>
  );
}

function FilaMiembro({ miembro, onNotice }: { miembro: MiembroDeVenta; onNotice: (message: string) => void }) {
  const [rol, setRol] = useState<RolVenta>(miembro.rolVenta);
  const [alias, setAlias] = useState(miembro.alias ?? "");
  const [secciones, setSecciones] = useState<SeccionAsignable[]>(miembro.secciones);
  // Lo último guardado: con eso se sabe si hay cambios sin guardar.
  const [guardado, setGuardado] = useState({
    rol: miembro.rolVenta,
    alias: miembro.alias ?? "",
    secciones: [...miembro.secciones].sort().join("|"),
  });
  const [guardando, setGuardando] = useState(false);
  const [abierta, setAbierta] = useState(false);

  const firmaSecciones = [...secciones].sort().join("|");
  const cambiaRol = rol !== guardado.rol || alias.trim().toUpperCase() !== guardado.alias;
  const cambianSecciones = firmaSecciones !== guardado.secciones;

  const guardar = async () => {
    setGuardando(true);
    if (cambiaRol) {
      const res = await guardarMiembroDeVenta({ userId: miembro.userId, rolVenta: rol, alias });
      if (!res.ok) {
        setGuardando(false);
        return onNotice(res.error);
      }
    }
    if (cambianSecciones && rol !== "admin") {
      const res = await guardarSeccionesDeMiembro({ userId: miembro.userId, secciones });
      if (!res.ok) {
        setGuardando(false);
        return onNotice(res.error);
      }
    }
    setGuardando(false);
    setGuardado({ rol, alias: alias.trim().toUpperCase(), secciones: firmaSecciones });
    onNotice(`Guardado: ${miembro.email}.`);
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
          <select value={rol} disabled={miembro.principal} onChange={(e) => setRol(e.target.value as RolVenta)} className={INPUT_CLASS}>
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
        <button
          type="button"
          disabled={(!cambiaRol && !cambianSecciones) || guardando}
          onClick={() => void guardar()}
          className={`${PRIMARY_BUTTON_CLASS} h-[46px]`}
        >
          {guardando ? "Guardando…" : "Guardar"}
        </button>
      </div>
      <p className="mt-2 text-xs text-neutral-500">{QUE_PUEDE[rol]}</p>

      {rol === "admin" ? (
        <p className="mt-3 text-xs text-neutral-500">Ve todas las secciones.</p>
      ) : (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setAbierta(!abierta)}
            className="cursor-pointer text-sm font-semibold text-amber-700 hover:underline dark:text-amber-300"
          >
            {abierta ? "Ocultar secciones" : `Secciones que ve (${secciones.length} de ${SECCIONES_ASIGNABLES.length})`}
          </button>
          {abierta && (
            <div className="mt-2">
              <CasillasDeSecciones elegidas={secciones} onCambio={setSecciones} />
            </div>
          )}
        </div>
      )}
    </li>
  );
}
