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
  const fila = (nombre: string, valor: string) => `<tr><th>${nombre}</th><td colspan="2">${escapar(valor)}</td></tr>`;
  return `<div class="etiqueta"><table>
  <colgroup><col class="c1"><col class="c2"><col class="c3"></colgroup>
  <tr class="cabeza">
    <td colspan="2"><div class="titulo">TRACKING</div><div class="tracking">${escapar(d?.tracking ?? "")}</div></td>
    <td class="celda-logo">${marca}</td>
  </tr>
  ${fila("CLIENTE", d?.cliente ?? "")}
  ${fila("DNI", d?.dni ?? "")}
  ${fila("DIRECCIÓN", (d?.direccion ?? "").toUpperCase())}
  ${fila("PEDIDO", pedidoLegible(d?.pedido ?? ""))}
</table></div>`;
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Roboto+Condensed:wght@400;700;800&display=swap" rel="stylesheet">
<style>
  @page { size: A4 portrait; margin: 6mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Roboto Condensed", "Arial Narrow", Arial, sans-serif; color: #111; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .hoja { width: 198mm; height: 284mm; display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: repeat(5, 1fr); gap: 2.5mm; page-break-after: always; }
  .hoja:last-child { page-break-after: auto; }
  /* Borde doble alrededor de cada etiqueta, como las de siempre. */
  .etiqueta { border: 4px double #222; padding: 1.2mm; overflow: hidden; display: flex; }
  table { width: 100%; height: 100%; border-collapse: collapse; table-layout: fixed; }
  col.c1 { width: 27%; } col.c2 { width: 43%; } col.c3 { width: 30%; }
  th, td { border: 1.4px solid #222; padding: 0.6mm 1.6mm; text-align: left; vertical-align: middle; }
  .cabeza td { height: 30%; }
  .titulo { font-weight: 800; font-size: 10pt; letter-spacing: 0.2px; }
  .tracking { font-weight: 800; font-size: 20pt; line-height: 1.05; white-space: nowrap; letter-spacing: -0.2px; }
  .celda-logo { text-align: center; padding: 0.8mm; }
  .logo { max-width: 100%; max-height: 15mm; object-fit: contain; display: block; margin: 0 auto; }
  .marca { font-weight: 900; font-style: italic; font-size: 15pt; }
  th { font-weight: 800; font-size: 10pt; }
  td { font-weight: 400; font-size: 10pt; line-height: 1.12; }
  .aviso { font: 13px Arial; padding: 10px; background: #fff7d6; border-bottom: 1px solid #e5d58a; }
  @media print { .aviso { display: none; } }
</style>
</head>
<body>
<div class="aviso">Si la ventana de impresión no se abre sola, presiona Ctrl + P. Elige papel A4 y márgenes "Predeterminados" o "Ninguno".</div>
${hojas.join("\n")}
<script>
  // Se imprime cuando ya cargaron la letra y el logo.
  window.addEventListener("load", function () {
    if (/sinimprimir/.test(location.hash)) return;
    var listo = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    listo.then(function () { setTimeout(function () { window.print(); }, 300); });
  });
</script>
</body>
</html>`;
}
