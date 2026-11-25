/**
 * Pedidos de Lima → Swayp: el Excel de carga masiva (el mismo que se subía a
 * mano) y el cuerpo de "Crear guía" de su API v2. Es puro: lo usan la
 * pantalla y el servidor, y lo prueba el runner de Node.
 */
import { DISTRITOS_LIMA, sugerirDistrito } from "./distritos-lima.ts";

export type ServicioSwayp = "EXPRESS" | "NORMAL";

export type FilaSwayp = {
  pedidoId: string;
  codigo: string;
  nombre: string;
  telefono: string;
  dni: string;
  /** Nombre del distrito, como en DISTRITOS_LIMA. */
  distrito: string;
  distritoSeguro: boolean;
  direccion: string;
  adicional: string;
  recaudo: number;
  contenido: string;
  /** "2026-11-25" */
  fecha: string;
  observaciones: string;
  servicio: ServicioSwayp;
};

type PedidoParaSwayp = {
  id: string;
  codigo: string;
  cliente: string;
  celular: string | null;
  dni: string | null;
  direccion: string | null;
  distrito: string | null;
  provincia: string | null;
  monto: number | null;
  adelanto: number | null;
  pedido: string | null;
  nota: string | null;
  envio: string | null;
};

const redondear = (n: number) => Math.round(n * 100) / 100;

export function filaSwaypDesdePedido(p: PedidoParaSwayp, hoy: string): FilaSwayp {
  // En los pedidos de Lima el distrito suele estar en "Provincia".
  const { distrito, seguro } = sugerirDistrito(p.distrito, p.provincia, p.direccion);
  return {
    pedidoId: p.id,
    codigo: p.codigo,
    nombre: p.cliente.trim(),
    telefono: (p.celular ?? "").replace(/\D/g, "").slice(-9),
    dni: (p.dni ?? "").replace(/\D/g, ""),
    distrito: distrito?.nombre ?? "",
    distritoSeguro: seguro,
    direccion: (p.direccion ?? "").trim(),
    adicional: "",
    recaudo: Math.max(0, redondear(Number(p.monto ?? 0) - Number(p.adelanto ?? 0))),
    contenido: (p.pedido ?? "").trim(),
    fecha: hoy,
    observaciones: (p.nota ?? "").trim(),
    servicio: /express/i.test(p.envio ?? "") ? "EXPRESS" : "NORMAL",
  };
}

/** Lo que falta para que Swayp acepte la fila. Vacío si está lista. */
export function problemasDeFilaSwayp(f: FilaSwayp): string[] {
  const faltan: string[] = [];
  if (!f.nombre) faltan.push("nombre");
  if (f.telefono.length !== 9) faltan.push("celular de 9 dígitos");
  if (!DISTRITOS_LIMA.some((d) => d.nombre === f.distrito)) faltan.push("distrito");
  if (!f.direccion) faltan.push("dirección");
  if (!f.contenido) faltan.push("contenido");
  return faltan;
}

/** Los títulos del Excel de carga masiva de Swayp, tal cual. */
export const COLUMNAS_EXCEL_SWAYP = [
  "id",
  "nombreDestinatario *",
  "telefonoDestinatario *",
  "nombreRemitente",
  "telefonoRemitente",
  "ciudadOrigen",
  "ciudad *",
  "direccionDestinatario *",
  "adicionalDireccion",
  "valorRecaudo *",
  "valorDeclarado",
  "nitDestinatario",
  "contenido *",
  "peso",
  "largo",
  "ancho",
  "alto",
  "fechaEntrega",
  "observaciones",
  "items",
  "servicio",
];

/** Las filas del Excel, títulos incluidos. */
export function filasExcelSwayp(filas: FilaSwayp[], remitente = "SOLUBRE"): string[][] {
  return [
    COLUMNAS_EXCEL_SWAYP,
    ...filas.map((f) => [
      f.codigo,
      f.nombre,
      f.telefono,
      remitente,
      "",
      "LIMA",
      f.distrito.replace(/\s*\(.*\)/, ""),
      f.direccion,
      f.adicional,
      f.recaudo.toFixed(2),
      "",
      "",
      f.contenido,
      "",
      "",
      "",
      "",
      f.fecha,
      f.observaciones,
      "1",
      f.servicio,
    ]),
  ];
}

export type RemitenteSwayp = {
  nombre: string;
  nit: string;
  direccion: string;
  telefono: string;
  email: string;
  ubigeo: string;
  idBodega?: number | null;
};

export type PaqueteSwayp = { peso: string; largo: string; ancho: string; alto: string };

/** "20x15x10" → largo, ancho, alto. */
export function medidasDe(texto: string | undefined, peso: string | undefined): PaqueteSwayp {
  const [largo, ancho, alto] = (texto || "20x15x10").split(/[x×*,\s]+/i).filter(Boolean);
  return { peso: (peso || "1").replace(",", "."), largo: largo || "20", ancho: ancho || "15", alto: alto || "10" };
}

/** El cuerpo de POST /v2/guias para una fila. */
export function cuerpoGuiaSwayp(
  f: FilaSwayp,
  remitente: RemitenteSwayp,
  paquete: PaqueteSwayp,
  productos?: { cantidad: number; codbar: string; nombre: string }[],
): Record<string, unknown> {
  const ubigeo = DISTRITOS_LIMA.find((d) => d.nombre === f.distrito)?.ubigeo ?? "";
  const cuerpo: Record<string, unknown> = {
    nombreRemitente: remitente.nombre,
    nitRemitente: remitente.nit,
    direccionRemitente: remitente.direccion,
    telefonoRemitente: remitente.telefono,
    telefonoRecogida: remitente.telefono,
    emailRemitente: remitente.email,
    ciudadRemitente: remitente.ubigeo,
    nombreDestinatario: f.nombre,
    nitDestinatario: f.dni || "0",
    direccionDestinatario: f.direccion,
    adicionalDireccion: f.adicional,
    telefonoDestinatario: f.telefono,
    // Swayp lo pide y los clientes casi nunca lo dan: va el del remitente.
    emailDestinatario: remitente.email,
    ciudadDestinatario: ubigeo,
    contenido: f.contenido,
    observaciones: [`Pedido ${f.codigo}`, f.observaciones].filter(Boolean).join(" · "),
    peso: paquete.peso,
    largo: paquete.largo,
    alto: paquete.alto,
    ancho: paquete.ancho,
    valorDeclarado: f.recaudo.toFixed(2),
    valorRecaudo: f.recaudo.toFixed(2),
    isExpress: f.servicio === "EXPRESS",
  };
  // Lo que no se tiene no se manda (como en el Excel): Swayp usa los datos de la cuenta.
  for (const [clave, valor] of Object.entries(cuerpo)) if (valor === "") delete cuerpo[clave];
  if (remitente.idBodega) cuerpo.idWarehouse = remitente.idBodega;
  if (productos?.length) cuerpo.productos = productos;
  return cuerpo;
}

/**
 * Los productos de un pedido con su código de Swayp, para que la guía
 * descuente su inventario. Null si alguno no tiene código (entonces va sólo
 * el contenido).
 */
export function productosParaSwayp(
  items: { producto: string; cantidad: number }[],
  codigos: Map<string, string>,
): { cantidad: number; codbar: string; nombre: string }[] | null {
  if (!items.length) return null;
  const lista = items.map((i) => ({ cantidad: i.cantidad, codbar: codigos.get(i.producto.toUpperCase()) ?? "", nombre: i.producto.toUpperCase() }));
  return lista.every((i) => i.codbar) ? lista : null;
}
