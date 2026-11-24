/**
 * Lo que devuelven `analitica_asesoras` y `analitica_empresa`, y las cuentas
 * chicas para mostrarlo. Es puro: lo prueba el runner de Node.
 */

export type AnaliticaAsesora = {
  alias: string;
  creados: number;
  creados_monto: number;
  creados_por_estado: Record<string, number>;
  creados_por_cierre: Record<string, number>;
  creados_por_dia: Record<string, number>;
  recibidos: number;
  recibidos_por_canal: Record<string, number>;
  gestionados: number;
  movidos_a: Record<string, number>;
  confirmados: number;
  entregados: number;
  entregados_monto: number;
  pendientes: {
    total: number;
    monto: number;
    volver_a_llamar: number;
    coordinacion: number;
    llamada_vencida: number;
    sin_llamada: number;
    mas_de_7_dias: number;
  };
  caidos: { total: number; monto: number; codigos: string[] };
};

export type DiaDeFlujosGuardado = {
  leads: number;
  leads_por_origen: Record<string, number>;
  leads_por_anuncio: Record<string, number>;
  ventas: number;
  ventas_ia: number;
  monto: number;
  ventas_por_etapa: Record<string, number>;
  actualizado_at: string;
};

export type DiaDeEmpresa = {
  dia: string;
  registrados: number;
  registrados_monto: number;
  por_canal: Record<string, number>;
  por_cierre: Record<string, number>;
  confirmados: number;
  entregados: number;
  entregados_monto: number;
  flujos: DiaDeFlujosGuardado | null;
  ia_llegaron: number;
  ia_programadas: number;
  ia_descartadas: number;
};

export type AnaliticaEmpresa = {
  dias: DiaDeEmpresa[];
  hoy: {
    pendientes: number;
    pendientes_monto: number;
    pendientes_mas_de_7_dias: number;
    caidos: number;
    caidos_monto: number;
    en_camino: number;
    en_camino_monto: number;
    ia_sin_programar: number;
  };
  estados_del_rango: Record<string, { n: number; monto: number }>;
};

export type Rango = "hoy" | "ayer" | "7dias" | "30dias" | "mes" | "mes_pasado" | "propio";

export const RANGOS: { valor: Rango; nombre: string }[] = [
  { valor: "hoy", nombre: "Hoy" },
  { valor: "ayer", nombre: "Ayer" },
  { valor: "7dias", nombre: "Últimos 7 días" },
  { valor: "30dias", nombre: "Últimos 30 días" },
  { valor: "mes", nombre: "Este mes" },
  { valor: "mes_pasado", nombre: "Mes pasado" },
  { valor: "propio", nombre: "Elegir fechas" },
];

/** El día de Lima ("2026-11-24") de un momento. Lima es UTC-5 todo el año. */
export function diaDeLima(momento: Date): string {
  return new Date(momento.getTime() - 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function sumarDias(dia: string, n: number): string {
  const fecha = new Date(`${dia}T12:00:00Z`);
  fecha.setUTCDate(fecha.getUTCDate() + n);
  return fecha.toISOString().slice(0, 10);
}

/** El periodo elegido → desde y hasta (días de Lima, ambos incluidos). */
export function rangoDe(rango: Rango, ahora: Date, propio: { desde: string; hasta: string }): { desde: string; hasta: string } {
  const hoy = diaDeLima(ahora);
  switch (rango) {
    case "ayer": {
      const ayer = sumarDias(hoy, -1);
      return { desde: ayer, hasta: ayer };
    }
    case "7dias":
      return { desde: sumarDias(hoy, -6), hasta: hoy };
    case "30dias":
      return { desde: sumarDias(hoy, -29), hasta: hoy };
    case "mes":
      return { desde: `${hoy.slice(0, 8)}01`, hasta: hoy };
    case "mes_pasado": {
      const finDelPasado = sumarDias(`${hoy.slice(0, 8)}01`, -1);
      return { desde: `${finDelPasado.slice(0, 8)}01`, hasta: finDelPasado };
    }
    case "propio": {
      const desde = propio.desde || hoy;
      const hasta = propio.hasta || desde;
      return desde <= hasta ? { desde, hasta } : { desde: hasta, hasta: desde };
    }
    default:
      return { desde: hoy, hasta: hoy };
  }
}

export function soles(monto: number | string | null | undefined): string {
  const n = Number(monto ?? 0) || 0;
  return `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

/** "25 %" — o "—" si no hay base. */
export function conversion(parte: number, total: number): string {
  if (!total) return "—";
  return `${Math.round((parte / total) * 100)} %`;
}

/** Los leads por anuncio de todos los días, de mayor a menor. */
export function sumarAnuncios(dias: DiaDeEmpresa[]): [string, number][] {
  const total = new Map<string, number>();
  for (const d of dias) {
    for (const [titulo, n] of Object.entries(d.flujos?.leads_por_anuncio ?? {})) total.set(titulo, (total.get(titulo) ?? 0) + n);
  }
  return [...total.entries()].sort((a, b) => b[1] - a[1]);
}

/** Las sumas del periodo, a partir de los días. */
export function totalesDelRango(empresa: AnaliticaEmpresa) {
  const porCierre: Record<string, number> = {};
  let registrados = 0;
  let registradosMonto = 0;
  let confirmados = 0;
  let entregados = 0;
  let entregadosMonto = 0;
  for (const d of empresa.dias) {
    registrados += d.registrados;
    registradosMonto += Number(d.registrados_monto) || 0;
    confirmados += d.confirmados;
    entregados += d.entregados;
    entregadosMonto += Number(d.entregados_monto) || 0;
    for (const [quien, n] of Object.entries(d.por_cierre)) porCierre[quien] = (porCierre[quien] ?? 0) + n;
  }
  return { registrados, registradosMonto, confirmados, entregados, entregadosMonto, porCierre };
}
