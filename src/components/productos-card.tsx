"use client";

import { ArrowDown, ArrowUp, Package, Plus } from "lucide-react";
import { useEffect, useState } from "react";

import { BOTON_SECUNDARIO } from "@/components/pedidos-ui";
import { Card, INPUT_CLASS, PRIMARY_BUTTON_CLASS } from "@/components/ui";
import { getSupabaseBrowser } from "@/lib/supabase/browser";

type Producto = { id: string; nombre: string; orden: number; activo: boolean };

const limpiar = (nombre: string) => nombre.trim().replace(/\s+/g, " ").toUpperCase();

/**
 * Configuración → Productos: el catálogo que se elige en cada pedido.
 * Cambiar un nombre lo cambia también en los pedidos que ya lo tienen.
 * Uno desactivado deja de ofrecerse, pero los pedidos viejos lo conservan.
 */
export function ProductosCard({ workspaceId, onNotice }: { workspaceId: string; onNotice: (mensaje: string) => void }) {
  const supabase = getSupabaseBrowser();
  const [productos, setProductos] = useState<Producto[] | null>(null);
  const [nombres, setNombres] = useState<Record<string, string>>({});
  const [nuevo, setNuevo] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    let vigente = true;
    void (async () => {
      const { data, error: falla } = await supabase
        .from("productos")
        .select("id, nombre, orden, activo")
        .eq("workspace_id", workspaceId)
        .order("orden")
        .order("nombre");
      if (!vigente) return;
      if (falla) setError(falla.message);
      else {
        const lista = (data ?? []) as Producto[];
        setProductos(lista);
        setNombres(Object.fromEntries(lista.map((p) => [p.id, p.nombre])));
      }
    })();
    return () => {
      vigente = false;
    };
  }, [supabase, workspaceId, recarga]);

  const hacer = async (accion: () => PromiseLike<{ error: { message: string } | null }>, mensaje: string) => {
    setOcupado(true);
    setError(null);
    const { error: falla } = await accion();
    setOcupado(false);
    if (falla) {
      setError(
        /renombrar_producto/.test(falla.message) ? "Falta correr el SQL de productos en Supabase (202612070001_productos.sql)." : falla.message,
      );
      return false;
    }
    onNotice(mensaje);
    setRecarga((n) => n + 1);
    return true;
  };

  const renombrar = (p: Producto) => {
    const limpio = limpiar(nombres[p.id] ?? "");
    if (!limpio || limpio === p.nombre) return;
    void hacer(
      () => supabase.rpc("renombrar_producto", { ws: workspaceId, producto: p.id, nuevo: limpio }),
      `Listo: ${p.nombre} ahora se llama ${limpio}, también en los pedidos que ya lo tenían.`,
    );
  };

  const agregar = async () => {
    const limpio = limpiar(nuevo);
    if (!limpio) return;
    if (productos?.some((p) => p.nombre === limpio)) return setError(`Ya hay un producto llamado ${limpio}.`);
    const orden = Math.max(0, ...(productos ?? []).map((p) => p.orden)) + 1;
    const ok = await hacer(
      () => supabase.from("productos").insert({ workspace_id: workspaceId, nombre: limpio, orden }),
      `Listo: se agregó ${limpio}.`,
    );
    if (ok) setNuevo("");
  };

  const mover = (i: number, paso: -1 | 1) => {
    if (!productos) return;
    const a = productos[i];
    const b = productos[i + paso];
    if (!a || !b) return;
    // Se intercambian los lugares; si tenían el mismo número, se separan.
    const ordenA = b.orden === a.orden ? a.orden + paso : b.orden;
    void hacer(
      async () => {
        const uno = await supabase.from("productos").update({ orden: ordenA }).eq("id", a.id);
        if (uno.error) return uno;
        return supabase.from("productos").update({ orden: a.orden }).eq("id", b.id);
      },
      "Orden guardado.",
    );
  };

  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <Package className="size-5" /> Productos
      </h2>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">
        Los productos que se eligen en cada pedido. Si cambias un nombre, también se cambia en los pedidos que ya lo tienen. Un producto
        desactivado deja de aparecer para pedidos nuevos.
      </p>

      {productos === null && !error && <p className="mt-3 text-sm text-neutral-500">Cargando…</p>}
      {productos && (
        <ul className="mt-4 space-y-2">
          {productos.map((p, i) => {
            const cambiado = limpiar(nombres[p.id] ?? "") !== p.nombre;
            return (
              <li key={p.id} className={`flex flex-wrap items-center gap-2 ${p.activo ? "" : "opacity-60"}`}>
                <div className="flex flex-col">
                  <button type="button" disabled={ocupado || i === 0} onClick={() => mover(i, -1)} className="cursor-pointer disabled:opacity-30" title="Subir">
                    <ArrowUp className="size-4" />
                  </button>
                  <button
                    type="button"
                    disabled={ocupado || i === productos.length - 1}
                    onClick={() => mover(i, 1)}
                    className="cursor-pointer disabled:opacity-30"
                    title="Bajar"
                  >
                    <ArrowDown className="size-4" />
                  </button>
                </div>
                <input
                  value={nombres[p.id] ?? ""}
                  onChange={(e) => setNombres((n) => ({ ...n, [p.id]: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && renombrar(p)}
                  className={`${INPUT_CLASS} h-10 min-w-0 flex-1 uppercase`}
                />
                {cambiado && (
                  <button type="button" disabled={ocupado} onClick={() => renombrar(p)} className={`${PRIMARY_BUTTON_CLASS} h-10`}>
                    Guardar nombre
                  </button>
                )}
                <label className="flex cursor-pointer items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={p.activo}
                    disabled={ocupado}
                    onChange={() =>
                      void hacer(
                        () => supabase.from("productos").update({ activo: !p.activo }).eq("id", p.id),
                        p.activo ? `${p.nombre} desactivado.` : `${p.nombre} activado.`,
                      )
                    }
                    className="size-4 accent-amber-500"
                  />
                  Activo
                </label>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <input
          value={nuevo}
          onChange={(e) => setNuevo(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void agregar()}
          placeholder="Nombre del producto nuevo"
          className={`${INPUT_CLASS} h-10 min-w-0 flex-1 uppercase`}
        />
        <button type="button" disabled={ocupado || !limpiar(nuevo)} onClick={() => void agregar()} className={`${BOTON_SECUNDARIO} h-10`}>
          <Plus className="size-4" /> Agregar producto
        </button>
      </div>

      {error && <p className="mt-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-500/10 dark:text-red-200">{error}</p>}
    </Card>
  );
}
