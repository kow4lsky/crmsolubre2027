/**
 * Las secciones del menú que el administrador puede mostrar u ocultar a cada
 * persona del equipo.
 *
 * Los nombres tienen que ser los mismos que los del menú en
 * `dashboard-app.tsx`: se guardan tal cual en `workspace_members.secciones`.
 * Base de datos, Configuración y Usuarios no están: son sólo del
 * administrador, porque sus acciones lo exigen en el servidor.
 */
import type { RolVenta } from "./pedidos.ts";

export const SECCIONES_ASIGNABLES = [
  { nombre: "Pedidos", detalle: "La tabla de pedidos (cada uno ve los que le tocan según su rol)." },
  { nombre: "Pedidos pendientes", detalle: "Las ventas que cerró la IA en Flujos, para programarlas." },
  { nombre: "Autorizaciones", detalle: "Sus pedidos de cambio de estado." },
  { nombre: "Llamadas", detalle: "Los leads que entraron hoy a Flujos y no se cerraron, para llamarlos y crearles ficha." },
  { nombre: "Analítica", detalle: "Sus números (una asesora ve sólo los suyos; el encargado, los de todas y los de la empresa)." },
  { nombre: "Inventario", detalle: "El stock de los almacenes, lo que salió y lo que tiene que regresar (administrador y encargado)." },
  { nombre: "Resumen", detalle: "Los números del día." },
  { nombre: "Conversaciones", detalle: "Los chats de WhatsApp, Instagram y Messenger." },
  { nombre: "Pipeline", detalle: "El embudo de ventas." },
  { nombre: "Contactos", detalle: "La lista de contactos." },
  { nombre: "Agenda", detalle: "Las citas." },
  { nombre: "Tareas", detalle: "Sus tareas y recordatorios." },
  { nombre: "Agentes IA", detalle: "Las instrucciones del agente. También le deja editarlas." },
] as const;

export type SeccionAsignable = (typeof SECCIONES_ASIGNABLES)[number]["nombre"];

const NOMBRES = new Set<string>(SECCIONES_ASIGNABLES.map((s) => s.nombre));

/** Las que ve alguien a quien todavía no se le eligieron secciones. */
export function seccionesPorDefecto(rol: RolVenta): SeccionAsignable[] {
  if (rol === "admin") return SECCIONES_ASIGNABLES.map((s) => s.nombre);
  return ["Pedidos", "Autorizaciones", "Tareas"];
}

/** Lo guardado en la base → lista limpia. Null o basura → las del rol. */
export function seccionesDe(guardadas: unknown, rol: RolVenta): SeccionAsignable[] {
  if (!Array.isArray(guardadas)) return seccionesPorDefecto(rol);
  return guardadas.filter((s): s is SeccionAsignable => typeof s === "string" && NOMBRES.has(s));
}

export function esSeccionAsignable(nombre: string): nombre is SeccionAsignable {
  return NOMBRES.has(nombre);
}
