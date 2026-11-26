/**
 * Cliente de Shalom PRO (pro.shalom.pe) para el servidor del CRM.
 *
 * Shalom no tiene API pública (lo confirmó su área comercial). El CRM usa las
 * mismas llamadas que la web de Shalom PRO, con la sesión que la persona abrió
 * en su navegador (la cookie enviashalom_session): el inicio de sesión (que tiene reCAPTCHA)
 * lo hace siempre ella; el CRM nunca guarda la contraseña ni salta el captcha.
 *
 * Es puro (sólo fetch): lo prueba el runner de Node contra un servidor falso.
 */

export const SHALOM_PRO = "https://pro.shalom.pe";

export class SesionVencida extends Error {}

type Respuesta = { success?: boolean; message?: string; data?: unknown };

/** Las cookies que va devolviendo Shalom, como haría un navegador. */
class Frasco {
  private cookies = new Map<string, string>();

  constructor(inicial: string) {
    this.agregar(inicial);
  }

  agregar(par: string) {
    const [nombre, ...resto] = par.split(";")[0].split("=");
    if (nombre?.trim()) this.cookies.set(nombre.trim(), resto.join("="));
  }

  guardar(headers: Headers) {
    const nuevas =
      typeof (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function"
        ? (headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
        : (headers.get("set-cookie") ?? "").split(/,(?=\s*[\w-]+=)/);
    for (const cookie of nuevas) if (cookie.trim()) this.agregar(cookie);
  }

  valor(nombre: string) {
    return this.cookies.get(nombre);
  }

  encabezado() {
    return [...this.cookies.entries()].map(([n, v]) => `${n}=${v}`).join("; ");
  }
}

export class ClienteShalomPro {
  private frasco: Frasco;
  private abierta = false;
  private base: string;

  constructor(cookies: string, base = SHALOM_PRO) {
    this.frasco = new Frasco("");
    for (const par of cookies.split(/;\s*/)) this.frasco.agregar(par);
    this.base = base;
  }

  private encabezados(extra: Record<string, string> = {}): Record<string, string> {
    const xsrf = this.frasco.valor("XSRF-TOKEN");
    return {
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
      Origin: this.base,
      Referer: `${this.base}/`,
      "User-Agent": "Mozilla/5.0 (CRM Solubre)",
      Cookie: this.frasco.encabezado(),
      ...(xsrf ? { "X-XSRF-TOKEN": decodeURIComponent(xsrf) } : {}),
      ...extra,
    };
  }

  /** Pide el token CSRF y confirma que la sesión sigue viva. */
  async abrir() {
    const csrf = await fetch(`${this.base}/sanctum/csrf-cookie`, { headers: this.encabezados(), cache: "no-store", redirect: "manual" });
    this.frasco.guardar(csrf.headers);
    this.abierta = true;
    const yo = await this.pedir("GET", "/auth/me");
    return yo;
  }

  /** Una llamada a /api/v1. Devuelve `data` del sobre { success, message, data }. */
  async pedir(metodo: "GET" | "POST" | "PUT" | "DELETE", ruta: string, cuerpo?: FormData | Record<string, unknown>, intento = 0): Promise<unknown> {
    if (!this.abierta && ruta !== "/auth/me") await this.abrir();
    const esFormulario = typeof FormData !== "undefined" && cuerpo instanceof FormData;
    const respuesta = await fetch(`${this.base}/api/v1${ruta}`, {
      method: metodo,
      headers: this.encabezados(cuerpo && !esFormulario ? { "Content-Type": "application/json" } : {}),
      body: cuerpo ? (esFormulario ? (cuerpo as FormData) : JSON.stringify(cuerpo)) : undefined,
      cache: "no-store",
      redirect: "manual",
    });
    this.frasco.guardar(respuesta.headers);

    // 419: venció el token CSRF; se pide otro y se reintenta una vez.
    if (respuesta.status === 419 && intento === 0) {
      const csrf = await fetch(`${this.base}/sanctum/csrf-cookie`, { headers: this.encabezados(), cache: "no-store", redirect: "manual" });
      this.frasco.guardar(csrf.headers);
      return this.pedir(metodo, ruta, cuerpo, 1);
    }
    if (respuesta.status === 401 || (respuesta.status >= 300 && respuesta.status < 400)) {
      throw new SesionVencida(
        "La sesión de Shalom PRO venció o se cerró. Entra a pro.shalom.pe, inicia sesión y vuelve a copiar la cookie enviashalom_session en Configuración → Conexiones → Shalom PRO.",
      );
    }
    const textoRespuesta = await respuesta.text();
    let json: Respuesta | unknown = null;
    try {
      json = textoRespuesta ? JSON.parse(textoRespuesta) : null;
    } catch {
      throw new Error(`Shalom PRO respondió algo que no se entiende (${respuesta.status}).`);
    }
    const sobre = json && typeof json === "object" && "success" in (json as object) ? (json as Respuesta) : null;
    if (!respuesta.ok || (sobre && sobre.success === false)) {
      const mensaje = (sobre?.message || (json as { message?: string } | null)?.message || `error ${respuesta.status}`).toString();
      throw new Error(`Shalom PRO: ${mensaje}`);
    }
    return sobre ? sobre.data : json;
  }
}

/**
 * Shalom contesta una lista vacía como si fuera un error ("Aún no ha agregado
 * envíos a su lista"). Para el CRM es sólo una lista vacía.
 */
const LISTA_VACIA = /no ha agregado|no hay (env|registr|resultad)|no se encontr|sin registros|no tiene env|no existen/i;

export async function pedirLista(cliente: ClienteShalomPro, ruta: string): Promise<unknown> {
  try {
    return await cliente.pedir("GET", ruta);
  } catch (error) {
    if (!(error instanceof SesionVencida) && error instanceof Error && LISTA_VACIA.test(error.message)) return [];
    throw error;
  }
}

/** Una lista de lo que devuelva Shalom: un arreglo, o un paginado { data: [...] }. */
export function lista(valor: unknown, profundidad = 0): Record<string, unknown>[] {
  if (Array.isArray(valor)) return valor as Record<string, unknown>[];
  if (valor && typeof valor === "object") {
    for (const clave of ["items", "data", "shipments", "rows"]) {
      const adentro = (valor as Record<string, unknown>)[clave];
      if (Array.isArray(adentro)) return adentro as Record<string, unknown>[];
    }
    // A veces viene envuelto otra vez: { data: { items: [...] } }.
    const data = (valor as Record<string, unknown>).data;
    if (data && typeof data === "object" && profundidad < 3) return lista(data, profundidad + 1);
  }
  return [];
}

/** La forma de una respuesta (sólo los nombres de los campos), para diagnosticar. */
export function formaDe(valor: unknown, profundidad = 0): string {
  if (Array.isArray(valor)) return `[${valor.length}]`;
  if (!valor || typeof valor !== "object" || profundidad > 2) return typeof valor;
  return `{${Object.entries(valor as Record<string, unknown>)
    .slice(0, 8)
    .map(([k, v]) => (v && typeof v === "object" ? `${k}:${formaDe(v, profundidad + 1)}` : k))
    .join(",")}}`;
}

/** Si un paginado de Laravel tiene más páginas. */
export function hayOtraPagina(valor: unknown): boolean {
  if (!valor || typeof valor !== "object") return false;
  let v = valor as Record<string, unknown>;
  if (!v.meta && !v.last_page && v.data && typeof v.data === "object" && !Array.isArray(v.data)) v = v.data as Record<string, unknown>;
  const meta = (v.meta as Record<string, unknown> | undefined) ?? v;
  const actual = Number(meta.current_page ?? 0);
  const ultima = Number(meta.last_page ?? 0);
  return actual > 0 && ultima > actual;
}

export type ResultadoDelRegistro = {
  /** Los borradores que Shalom aceptó y se enviaron. */
  enviados: Record<string, unknown>[];
  /** Los que Shalom marcó con error y quedaron sin enviar en Shalom PRO. */
  conError: Record<string, unknown>[];
  mensaje: string;
};

/**
 * El registro masivo, como en la web: sube el Excel, toma sólo los borradores
 * nuevos, les pone la clave de seguridad y los envía.
 */
export async function registrarMasivo(cliente: ClienteShalomPro, archivo: Uint8Array, clave: string): Promise<ResultadoDelRegistro> {
  const antes = new Set(lista(await pedirLista(cliente, "/service-orders")).map((b) => String(b.id)));

  const formulario = new FormData();
  formulario.append(
    "file",
    new Blob([archivo as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    "envios.xlsx",
  );
  await cliente.pedir("POST", "/service-orders/import", formulario);

  const nuevos = lista(await pedirLista(cliente, "/service-orders")).filter((b) => !antes.has(String(b.id)));
  const conError = nuevos.filter((b) => b.error);
  const listos = nuevos.filter((b) => !b.error);
  if (listos.length === 0) {
    return { enviados: [], conError, mensaje: nuevos.length ? "Shalom rechazó todos los envíos del archivo." : "Shalom no creó ningún envío con el archivo." };
  }
  const ids = listos.map((b) => b.id);
  if (clave.trim()) await cliente.pedir("POST", "/service-orders/security-code/massive", { code: clave.trim(), ids });
  const envio = await cliente.pedir("POST", "/service-orders/send", { shipments: ids });
  const mensaje = envio && typeof envio === "object" && "message" in envio ? String((envio as { message: unknown }).message) : "Envíos registrados.";
  return { enviados: listos, conError, mensaje };
}

/** Los envíos registrados entre dos días ("2026-11-24"), de todas las páginas. */
export async function historial(cliente: ClienteShalomPro, desde: string, hasta: string, paginasMaximas = 30) {
  const todos: Record<string, unknown>[] = [];
  for (let pagina = 1; pagina <= paginasMaximas; pagina++) {
    const params = new URLSearchParams({ page: String(pagina), from_date: desde, to_date: hasta });
    const respuesta = await pedirLista(cliente, `/service-orders/shipments/history?${params}`);
    todos.push(...lista(respuesta));
    if (!hayOtraPagina(respuesta)) break;
  }
  return todos;
}

/**
 * Los envíos con su estado (en origen, en tránsito, en destino…), como la
 * pantalla "Rastreo" de Shalom PRO. El historial no trae el estado: sólo esta.
 */
export async function rastreo(cliente: ClienteShalomPro, paginasMaximas = 60, filtros: Record<string, string> = {}) {
  const todos: Record<string, unknown>[] = [];
  let forma = "";
  for (let pagina = 1; pagina <= paginasMaximas; pagina++) {
    // Los mismos parámetros que manda la pantalla Rastreo de Shalom PRO.
    const params = new URLSearchParams({ page: String(pagina), document_type: "DNI", order_by: "desc", per_page: "20", ...filtros });
    const respuesta = await pedirLista(cliente, `/service-orders/shipments/tracking?${params}`);
    if (pagina === 1) forma = formaDe(respuesta);
    const items = lista(respuesta);
    todos.push(...items);
    if (!items.length || !hayOtraPagina(respuesta)) break;
  }
  return Object.assign(todos, { forma });
}

/** Los envíos registrados que esperan que se lleven a la agencia. */
export async function pendientes(cliente: ClienteShalomPro) {
  return lista(await pedirLista(cliente, "/service-orders/shipments/pending-approval"));
}
