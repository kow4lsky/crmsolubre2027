/**
 * Inventario: el reporte de Swayp, el cuadre con lo que calculó el CRM y las
 * etiquetas del kárdex. Es puro: lo usa la pantalla y lo prueba el runner.
 */

export type Almacen = "SWAYP" | "SOLUBRE";

export type FilaDeStock = {
  almacen: string;
  producto_id: string;
  producto: string;
  codigo_swayp: string | null;
  activo: boolean;
  bodega: number;
  camino: number;
  minimo: number;
  por_dia: number;
};

/** Una fila del reporte de inventario de Swayp. */
export type FilaSwayp = { codigo: string; nombre: string; cantidad: number; transito: number; devolucion: number };

const limpiar = (texto: string) =>
  texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();

const entero = (texto: string | undefined) => {
  const n = Number(String(texto ?? "").replace(/[^\d-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * El Excel de "Inventario → Exportar a Excel" de Swayp → filas. Busca la fila
 * de títulos (CÓDIGO BARRAS, NOMBRE, CANTIDAD…) donde esté, y suma las
 * bodegas si un producto aparece en más de una.
 */
export function leerReporteSwayp(filas: string[][]): FilaSwayp[] {
  const iTitulos = filas.findIndex((f) => f.some((c) => /NOMBRE/.test(limpiar(c))) && f.some((c) => /CANTIDAD|DISPONIBLE/.test(limpiar(c))));
  if (iTitulos < 0) throw new Error("No encontré las columnas del reporte de Swayp (Código barras, Nombre, Cantidad).");
  const titulos = filas[iTitulos].map(limpiar);
  const col = (...nombres: RegExp[]) => titulos.findIndex((t) => nombres.some((n) => n.test(t)));
  const cCodigo = col(/CODIGO/, /BARRAS/, /SKU/);
  const cNombre = col(/^NOMBRE/, /PRODUCTO/);
  const cCantidad = col(/^CANTIDAD/, /STOCK/) >= 0 ? col(/^CANTIDAD/, /STOCK/) : col(/DISPONIBLE/);
  const cTransito = col(/TRANSITO/);
  const cDevolucion = col(/DEVOLUCION/);

  const porCodigo = new Map<string, FilaSwayp>();
  for (const fila of filas.slice(iTitulos + 1)) {
    const nombre = (fila[cNombre] ?? "").trim();
    const codigo = (cCodigo >= 0 ? fila[cCodigo] : "")?.trim() || nombre;
    if (!nombre && !codigo) continue;
    const previo = porCodigo.get(limpiar(codigo));
    const nueva: FilaSwayp = {
      codigo,
      nombre: nombre || codigo,
      cantidad: entero(fila[cCantidad]) + (previo?.cantidad ?? 0),
      transito: (cTransito >= 0 ? entero(fila[cTransito]) : 0) + (previo?.transito ?? 0),
      devolucion: (cDevolucion >= 0 ? entero(fila[cDevolucion]) : 0) + (previo?.devolucion ?? 0),
    };
    porCodigo.set(limpiar(codigo), nueva);
  }
  return [...porCodigo.values()];
}

/** El producto del CRM de cada fila de Swayp: por su código guardado, o por el nombre. */
export function emparejarConProductos<P extends { id: string; nombre: string; codigo_swayp: string | null }>(
  filas: FilaSwayp[],
  productos: P[],
): Map<string, P> {
  const resultado = new Map<string, P>();
  for (const fila of filas) {
    const porCodigo = productos.find((p) => p.codigo_swayp && limpiar(p.codigo_swayp) === limpiar(fila.codigo));
    const porNombre = productos.find((p) => limpiar(p.nombre) === limpiar(fila.nombre) || limpiar(p.nombre) === limpiar(fila.codigo));
    const producto = porCodigo ?? porNombre;
    if (producto) resultado.set(fila.codigo, producto);
  }
  return resultado;
}

export const TIPOS_DE_MOVIMIENTO: Record<string, string> = {
  INICIAL: "Stock inicial",
  INGRESO: "Ingreso",
  AJUSTE: "Ajuste",
  CUADRE: "Cuadre",
  TRANSFERENCIA: "Envío entre almacenes",
  SALIDA: "Salió con pedido",
  ENTREGA: "Entregado",
  RETORNO: "Regresó",
};

/** Cuántos días alcanza el stock al ritmo de los últimos 7 días (null si no se vendió). */
export function diasQueAlcanza(bodega: number, porDia: number): number | null {
  if (!porDia || porDia <= 0) return null;
  return Math.floor(bodega / porDia);
}
