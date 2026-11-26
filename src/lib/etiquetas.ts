/**
 * La hoja de etiquetas para imprimir: A4, 10 por hoja (2 columnas × 5 filas),
 * como las que se pegaban en las cajas: TRACKING grande, logo, y una tabla con
 * cliente, DNI, dirección y pedido. Es puro: lo prueba el runner de Node.
 */

export type DatosEtiqueta = { tracking: string; cliente: string; dni: string; direccion: string; pedido: string };

export const ETIQUETAS_POR_HOJA = 10;

const escapar = (texto: string) =>
  texto.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** "3xLIMPIAXPRESS, 1xCV" se ve mejor con espacio después de la coma. */
const pedidoLegible = (texto: string) => texto.replace(/\s*,\s*/g, ", ").toUpperCase();

function etiqueta(d: DatosEtiqueta | null, logo: string | null): string {
  // Si la imagen del logo no carga, queda el texto SOLUBRE.
  const marca = logo
    ? `<img class="logo" src="${escapar(logo)}" alt="Solubre" onerror="this.outerHTML='<span class=&quot;marca&quot;>SOLUBRE</span>'">`
    : `<span class="marca">SOLUBRE</span>`;
  const fila = (nombre: string, valor: string) =>
    `<tr><th>${nombre}</th><td>${escapar(valor)}</td></tr>`;
  return `<div class="etiqueta">
  <div class="cabeza">
    <div><div class="titulo">TRACKING</div><div class="tracking">${escapar(d?.tracking ?? "")}</div></div>
    ${marca}
  </div>
  <table>
    ${fila("CLIENTE", d?.cliente ?? "")}
    ${fila("DNI", d?.dni ?? "")}
    ${fila("DIRECCIÓN", (d?.direccion ?? "").toUpperCase())}
    ${fila("PEDIDO", pedidoLegible(d?.pedido ?? ""))}
  </table>
</div>`;
}

/** El HTML completo, listo para abrir e imprimir. `logo` es la URL de la imagen (o null para el texto SOLUBRE). */
export function htmlDeEtiquetas(etiquetas: DatosEtiqueta[], logo: string | null = null): string {
  const hojas: string[] = [];
  for (let i = 0; i < Math.max(etiquetas.length, 1); i += ETIQUETAS_POR_HOJA) {
    const tanda = etiquetas.slice(i, i + ETIQUETAS_POR_HOJA);
    // La última hoja se completa con etiquetas vacías para que no se deforme.
    const celdas = [...tanda.map((d) => etiqueta(d, logo)), ...Array.from({ length: ETIQUETAS_POR_HOJA - tanda.length }, () => etiqueta(null, logo))];
    hojas.push(`<section class="hoja">${celdas.join("")}</section>`);
  }
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Etiquetas Solubre</title>
<style>
  @page { size: A4 portrait; margin: 6mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #111; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .hoja { width: 198mm; height: 284mm; display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: repeat(5, 1fr); gap: 3mm; page-break-after: always; }
  .hoja:last-child { page-break-after: auto; }
  .etiqueta { border: 3px double #222; padding: 2.5mm 3mm; display: flex; flex-direction: column; overflow: hidden; }
  .cabeza { display: flex; justify-content: space-between; align-items: center; gap: 2mm; margin-bottom: 1.5mm; }
  .titulo { font-weight: 800; font-size: 11pt; }
  .tracking { font-weight: 900; font-size: 19pt; letter-spacing: 0.2px; white-space: nowrap; }
  .logo { max-height: 15mm; max-width: 30mm; object-fit: contain; }
  .marca { font-weight: 900; font-style: italic; font-size: 16pt; color: #d11; transform: skew(-8deg); }
  table { width: 100%; border-collapse: collapse; flex: 1; font-size: 9.5pt; }
  th, td { border: 1px solid #333; padding: 1mm 1.5mm; text-align: left; vertical-align: middle; }
  th { width: 25mm; font-weight: 800; background: #f2f2f2; }
  td { font-weight: 600; line-height: 1.15; }
  .aviso { font: 13px Arial; padding: 10px; background: #fff7d6; border-bottom: 1px solid #e5d58a; }
  @media print { .aviso { display: none; } }
</style>
</head>
<body>
<div class="aviso">Si la ventana de impresión no se abre sola, presiona Ctrl + P. Elige papel A4 y márgenes "Predeterminados" o "Ninguno".</div>
${hojas.join("\n")}
<script>if (!/sinimprimir/.test(location.hash)) window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 400); });</script>
</body>
</html>`;
}
