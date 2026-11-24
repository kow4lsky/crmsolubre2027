/**
 * Cliente mínimo de MCP sobre HTTP ("streamable HTTP"): initialize,
 * notifications/initialized y tools/call. Lo usa la sincronización con Flujos.
 * Es puro (sólo fetch): lo prueba el runner de Node contra un servidor falso.
 */

/**
 * Llama a una herramienta de un servidor MCP (protocolo MCP sobre
 * HTTP: initialize, initialized y tools/call). Devuelve el JSON que viene
 * como texto en la respuesta.
 */
export async function llamarHerramientaMcp(url: string, token: string, herramienta: string, argumentos: Record<string, unknown>) {
  const base = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    // Sin esto, fetch se presenta como "node" y algunos filtros anti-robots lo frenan.
    "User-Agent": "crm-solubre/1 (+mcp)",
  };
  let sesion: string | null = null;
  let siguienteId = 1;

  const enviar = async (cuerpo: Record<string, unknown>) => {
    const respuesta = await fetch(url, {
      method: "POST",
      headers: sesion ? { ...base, "Mcp-Session-Id": sesion } : base,
      body: JSON.stringify({ jsonrpc: "2.0", ...cuerpo }),
      cache: "no-store",
    });
    sesion = respuesta.headers.get("mcp-session-id") ?? sesion;
    if (!respuesta.ok && respuesta.status !== 202) {
      const detalle = await respuesta.text();
      if (esBloqueoAntiRobots(respuesta.headers, detalle)) {
        throw new Error(
          "La protección anti-robots de Flujos (Cloudflare) frenó al CRM antes de llegar a tu cuenta. " +
            "No es tu token: hay que pedirle a soporte de Flujos que deje pasar las consultas al MCP desde servidores.",
        );
      }
      if (respuesta.status === 401) throw new Error("Flujos no aceptó el token. Renuévalo y vuelve a pegarlo en Conexiones.");
      throw new Error(`Flujos respondió ${respuesta.status}: ${detalle.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160)}`);
    }
    if (!("id" in cuerpo)) return null;
    const texto = await respuesta.text();
    // La respuesta puede venir como JSON o como eventos ("data: {...}").
    const candidatos = (respuesta.headers.get("content-type") ?? "").includes("event-stream")
      ? texto.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim())
      : [texto];
    for (const candidato of candidatos) {
      try {
        const json = JSON.parse(candidato) as { id?: number; result?: unknown; error?: { message?: string } };
        if (json.id !== cuerpo.id) continue;
        if (json.error) throw new Error(json.error.message ?? "Error de Flujos");
        return json.result;
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }
    throw new Error("Flujos no devolvió una respuesta legible.");
  };

  await enviar({
    id: siguienteId++,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "crm-solubre", version: "1" } },
  });
  // Algunos servidores sin sesión no esperan este aviso: si lo rechazan, se sigue.
  await enviar({ method: "notifications/initialized" }).catch(() => null);
  const resultado = (await enviar({
    id: siguienteId++,
    method: "tools/call",
    params: { name: herramienta, arguments: argumentos },
  })) as { content?: { type?: string; text?: string }[]; isError?: boolean } | null;

  const texto = resultado?.content?.find((c) => c.type === "text")?.text ?? "";
  if (resultado?.isError) throw new Error(texto || `Error en ${herramienta}`);
  return JSON.parse(texto) as Record<string, unknown>;
}


/** La página "Just a moment..." de Cloudflare: no llega al servidor de Flujos. */
export function esBloqueoAntiRobots(cabeceras: Headers, cuerpo: string) {
  return cabeceras.get("cf-mitigated") === "challenge" || /<title>\s*Just a moment/i.test(cuerpo) || /challenge-platform/.test(cuerpo);
}
