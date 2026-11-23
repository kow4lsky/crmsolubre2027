/**
 * Lee la pestaña "base" del Google Sheet (descargada como CSV) y la deja lista
 * para `importar_pedidos()` en Postgres.
 *
 * Las columnas se reconocen por el título, sin importar el orden, los acentos
 * ni las mayúsculas: la planilla cambió de forma muchas veces y no hay que
 * reacomodarla para importar. Lo que no tiene una columna propia en `pedidos`
 * va a `extra` con su título original: no se pierde nada.
 */

import { ESTADOS, type Estado } from "./pedidos.ts";

/** Título normalizado → columna de `pedidos`. */
const COLUMNAS: Record<string, string> = {
  COD: "codigo",
  CODIGO: "codigo",
  "F CRE": "fecha_creacion",
  "F REG": "fecha_registro",
  MONTO: "monto",
  PEDIDO: "pedido",
  CLIENTE: "cliente",
  DIRECCION: "direccion",
  DNI: "dni",
  "DNI O RUC": "dni",
  PROVINCIA: "provincia",
  DISTRITO: "distrito",
  CELULAR: "celular",
  DESTINO: "destino",
  ESTADO: "estado",
  "ESTADO CRM": "estado",
  ASESOR: "asesor",
  CANAL: "canal",
  "ULT GESTION": "ultima_gestion",
  TRACKING: "tracking",
  CLAVE: "clave",
  NOTA: "nota",
  ADELANTO: "adelanto",
  INVENTARIO: "inventario",
  "F SALIDA": "fecha_salida",
  "F ENTREGADO": "fecha_entregado",
  ENVIO: "envio",
  COURIER: "courier",
  "COSTO ENVIO": "costo_envio",
  "CREADO POR": "creado_por",
  "ASIGNADO A": "asignado_a",
  "ENCARGADO ASIGNADO": "encargado",
  "F ASIG ENCARGADO": "fecha_asig_encargado",
  "F PRIMERA GESTION": "fecha_primera_gestion",
  "F ESTADO": "fecha_estado",
  "F CONFIRMADO": "fecha_confirmado",
  "TIPO CLIENTE": "tipo_cliente",
  "PROX LLAMADA": "prox_llamada",
  "TIPO VENTA": "tipo_venta",
  COMISION: "comision",
  "CERRADO POR": "cerrado_por",
  "PAGO COMPLETO": "pago_completo",
  "ESTADO ETIQUETA": "estado_etiqueta",
  "F ETIQUETA": "fecha_etiqueta",
  "ESTADO SHALOM": "estado_shalom",
};

/** Las columnas de producto de la planilla. Cada celda es una cantidad. */
export const PRODUCTOS_DE_LA_PLANILLA = [
  "SOLUBRE", "BROCHAS", "LIMPIAXPRESS", "MILDREW", "HYPERCLEAN", "CHISGUETE", "PAÑO",
  "CAJAS", "CEPILLO VERDE", "PIPIBYE", "CEPILLO DOBLE NEGRO", "PLUMON ROJO", "PLUMON BLANCO",
];

const FECHAS_CON_HORA = new Set([
  "fecha_creacion", "ultima_gestion", "fecha_salida", "fecha_entregado", "fecha_asig_encargado",
  "fecha_primera_gestion", "fecha_estado", "fecha_confirmado", "fecha_etiqueta",
]);
const FECHAS_SOLAS = new Set(["fecha_registro", "prox_llamada"]);
const NUMEROS = new Set(["monto", "costo_envio", "adelanto", "comision"]);
const ALIAS = new Set(["asesor", "creado_por", "asignado_a", "encargado"]);

/**
 * Los códigos de usuario viejos que en realidad son la misma persona. Copiado
 * de `ADVISOR_IDENTITY_ALIASES` del CRM en Apps Script.
 */
export const ALIAS_DE_ASESORES: Record<string, string> = {
  MBV0726: "MILTON",
  MBARUA: "MILTON",
  DIGR726: "DIEGO",
  YAH0728: "YAHAIRA",
  NATH727: "NATHALY",
  NSANCHEZ: "NATHALY",
};

/** Sin acentos, en mayúsculas y con un solo espacio entre palabras. */
export function normalizarTitulo(titulo: string): string {
  return titulo
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9Ñ]+/g, " ")
    .trim();
}

const ESTADOS_POR_CLAVE = new Map<string, Estado>(
  ESTADOS.map((estado) => [normalizarTitulo(estado), estado]),
);
ESTADOS_POR_CLAVE.set("VOLVER LLAMAR", "VOLVER A LLAMAR");
ESTADOS_POR_CLAVE.set("RELLAMAR", "VOLVER A LLAMAR");
ESTADOS_POR_CLAVE.set("NO CONTESTA", "NC");

/** El estado escrito como sea → uno de los diez. `null` si no se reconoce. */
export function leerEstado(valor: string): Estado | null {
  const clave = normalizarTitulo(valor);
  if (!clave) return "VOLVER A LLAMAR";
  return ESTADOS_POR_CLAVE.get(clave) ?? null;
}

/**
 * "S/ 1,234.50", "89.9", "89,90" → número. Vacío → null.
 * Con punto y coma juntos, el que aparece último es el decimal.
 */
export function leerMonto(valor: string): number | null {
  let texto = valor.replace(/[^\d,.-]/g, "");
  if (!texto || !/\d/.test(texto)) return null;
  const coma = texto.lastIndexOf(",");
  const punto = texto.lastIndexOf(".");
  if (coma > -1 && punto > -1) {
    texto = coma > punto ? texto.replace(/\./g, "").replace(",", ".") : texto.replace(/,/g, "");
  } else if (coma > -1) {
    // "1,234" es mil doscientos; "89,90" es ochenta y nueve con noventa.
    texto = /,\d{3}$/.test(texto) && texto.indexOf(",") === coma ? texto.replace(",", "") : texto.replace(",", ".");
  }
  const numero = Number(texto);
  return Number.isFinite(numero) ? Math.round(numero * 100) / 100 : null;
}

/**
 * "24/11/2026", "24/11/2026 15:30", "2026-11-24 15:30:00" → partes. Las fechas de
 * la planilla están en hora de Lima (UTC-5, sin horario de verano).
 */
function partesDeFecha(valor: string): { dia: string; hora: string | null } | null {
  const texto = valor.trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(texto);
  if (m) {
    const dia = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    const hora = m[4] ? `${m[4].padStart(2, "0")}:${m[5]}:${m[6] ?? "00"}` : null;
    return validar(dia) ? { dia, hora } : null;
  }
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(texto);
  if (m) {
    const dia = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    const hora = m[4] ? `${m[4].padStart(2, "0")}:${m[5]}:${m[6] ?? "00"}` : null;
    return validar(dia) ? { dia, hora } : null;
  }
  return null;
}

function validar(dia: string): boolean {
  const fecha = new Date(`${dia}T12:00:00Z`);
  return !Number.isNaN(fecha.getTime()) && fecha.toISOString().slice(0, 10) === dia;
}

/** Fecha sola: "2026-11-24". */
export function leerDia(valor: string): string | null {
  return partesDeFecha(valor)?.dia ?? null;
}

/** Fecha con hora, en Lima: "2026-11-24T15:30:00-05:00". */
export function leerMomento(valor: string): string | null {
  const partes = partesDeFecha(valor);
  if (!partes) return null;
  return `${partes.dia}T${partes.hora ?? "00:00:00"}-05:00`;
}

/** Celular de Perú: los últimos 9 dígitos. Si no son 9, queda como vino. */
export function leerCelular(valor: string): string | null {
  const digitos = valor.replace(/\D/g, "");
  if (!digitos) return valor.trim() || null;
  if (digitos.length > 9 && digitos.startsWith("51")) return digitos.slice(-9);
  return digitos;
}

export function leerAlias(valor: string): string | null {
  const limpio = valor.trim().toUpperCase();
  if (!limpio) return null;
  return ALIAS_DE_ASESORES[normalizarTitulo(limpio)] ?? limpio;
}

export type FilaPedido = Record<string, unknown> & {
  codigo: string;
  items: Record<string, number>;
  extra: Record<string, string>;
};

export type LecturaDePedidos = {
  filas: FilaPedido[];
  /** Títulos que se reconocieron, para mostrarle a la persona qué se va a cargar. */
  reconocidas: string[];
  /** Títulos que van a `extra`. */
  extras: string[];
  sinCodigo: number;
  /** Códigos que aparecen en más de una fila: no se importa ninguna de sus filas. */
  codigosRepetidos: number;
  /** Cada fila de un código repetido, para revisarla. */
  detalleRepetidos: DetalleRepetido[];
  fueraDeRango: number;
  estadosDesconocidos: Record<string, number>;
  error: string | null;
};

/**
 * Las filas del CSV (con el título en la primera) → pedidos. `desde` deja
 * afuera los registrados antes de esa fecha ("2026-05-01").
 */
export function leerPedidos(filasCsv: string[][], desde: string | null = null): LecturaDePedidos {
  const vacia: LecturaDePedidos = {
    filas: [], reconocidas: [], extras: [], sinCodigo: 0, codigosRepetidos: 0, detalleRepetidos: [], fueraDeRango: 0,
    estadosDesconocidos: {}, error: null,
  };

  // El título puede no estar en la primera fila: se busca el renglón con COD.
  const inicio = filasCsv.slice(0, 10).findIndex((fila) => fila.some((celda) => {
    const t = normalizarTitulo(celda);
    return t === "COD" || t === "CODIGO";
  }));
  if (inicio === -1) {
    return { ...vacia, error: "No encontré la columna COD. ¿Es la pestaña \"base\" de la planilla?" };
  }

  const titulos = filasCsv[inicio];
  const productos = new Set(PRODUCTOS_DE_LA_PLANILLA.map(normalizarTitulo));
  type Destino = { tipo: "columna"; columna: string } | { tipo: "producto"; nombre: string } | { tipo: "extra"; titulo: string } | null;

  const usadas = new Set<string>();
  const destinos: Destino[] = titulos.map((original) => {
    const titulo = original.trim();
    const clave = normalizarTitulo(titulo);
    if (!clave) return null;
    if (productos.has(clave)) return { tipo: "producto", nombre: titulo.toUpperCase() };
    const columna = COLUMNAS[clave];
    // Si dos columnas dicen lo mismo, gana la primera y la otra va a extra.
    if (columna && !usadas.has(columna)) {
      usadas.add(columna);
      return { tipo: "columna", columna };
    }
    return { tipo: "extra", titulo };
  });

  const lectura: LecturaDePedidos = {
    ...vacia,
    reconocidas: titulos.filter((_, i) => destinos[i]?.tipo === "columna" || destinos[i]?.tipo === "producto").map((t) => t.trim()),
    extras: titulos.filter((_, i) => destinos[i]?.tipo === "extra").map((t) => t.trim()),
  };

  const leidas: FilaPedido[] = [];

  for (const celdas of filasCsv.slice(inicio + 1)) {
    const fila: FilaPedido = { codigo: "", items: {}, extra: {} };

    destinos.forEach((destino, i) => {
      const valor = (celdas[i] ?? "").trim();
      if (!destino || !valor) return;

      if (destino.tipo === "producto") {
        const cantidad = leerMonto(valor);
        if (cantidad && cantidad > 0) fila.items[destino.nombre] = cantidad;
        return;
      }
      if (destino.tipo === "extra") {
        fila.extra[destino.titulo] = valor;
        return;
      }

      const { columna } = destino;
      if (columna === "codigo") fila.codigo = valor.toUpperCase();
      else if (columna === "estado") {
        const estado = leerEstado(valor);
        if (estado) fila.estado = estado;
        else {
          fila.estado = "VOLVER A LLAMAR";
          fila.extra["ESTADO ORIGINAL"] = valor;
          lectura.estadosDesconocidos[valor] = (lectura.estadosDesconocidos[valor] ?? 0) + 1;
        }
      } else if (FECHAS_SOLAS.has(columna)) {
        const dia = leerDia(valor);
        if (dia) fila[columna] = dia;
        else fila.extra[titulos[i].trim()] = valor;
      } else if (FECHAS_CON_HORA.has(columna)) {
        const momento = leerMomento(valor);
        if (momento) fila[columna] = momento;
        else fila.extra[titulos[i].trim()] = valor;
      } else if (NUMEROS.has(columna)) {
        const numero = leerMonto(valor);
        if (numero !== null) fila[columna] = numero;
        else fila.extra[titulos[i].trim()] = valor;
      } else if (columna === "celular") fila.celular = leerCelular(valor);
      else if (ALIAS.has(columna)) fila[columna] = leerAlias(valor);
      // En la planilla vieja Swayp figuraba como "Swipe".
      else if (columna === "courier") fila.courier = /^swipe$/i.test(valor) ? "Swayp" : valor;
      else fila[columna] = valor;
    });

    if (!fila.codigo) {
      if (Object.keys(fila).length > 3 || Object.keys(fila.extra).length) lectura.sinCodigo += 1;
      continue;
    }

    // Sin F.REG se usa la fecha de creación: toda fila necesita un día.
    if (!fila.fecha_registro && typeof fila.fecha_creacion === "string") {
      fila.fecha_registro = fila.fecha_creacion.slice(0, 10);
    }
    leidas.push(fila);
  }

  // Un código que aparece en más de una fila no se importa: ninguna de sus
  // filas. Así una entrega nunca se cuenta dos veces. Quedan en la planilla y
  // en la lista para revisar. Se cuenta sobre todo el archivo, antes del
  // filtro de fecha: si una de las filas es vieja, el código igual está repetido.
  const veces = new Map<string, number>();
  for (const fila of leidas) veces.set(fila.codigo, (veces.get(fila.codigo) ?? 0) + 1);

  for (const fila of leidas) {
    if ((veces.get(fila.codigo) ?? 0) > 1) {
      lectura.detalleRepetidos.push(detalle(fila, fila.codigo, "No se importa: código repetido"));
      continue;
    }
    if (desde && typeof fila.fecha_registro === "string" && fila.fecha_registro < desde) {
      lectura.fueraDeRango += 1;
      continue;
    }
    lectura.filas.push(fila);
  }

  lectura.codigosRepetidos = [...veces.values()].filter((n) => n > 1).length;
  return lectura;
}

export type DetalleRepetido = {
  codigo: string;
  cliente: string;
  celular: string;
  fecha: string;
  estado: string;
  monto: string;
  asesor: string;
  decision: string;
};

function detalle(fila: FilaPedido, codigo: string, decision: string): DetalleRepetido {
  return {
    codigo,
    cliente: String(fila.cliente ?? ""),
    celular: String(fila.celular ?? ""),
    fecha: String(fila.fecha_registro ?? ""),
    estado: String(fila.estado ?? ""),
    monto: fila.monto === undefined ? "" : String(fila.monto),
    asesor: String(fila.asesor ?? ""),
    decision,
  };
}

/** De a cuántos pedidos se mandan a la base. */
export const TANDA_DE_IMPORTACION = 400;
