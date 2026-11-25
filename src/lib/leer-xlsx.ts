/**
 * Lee la primera hoja de un Excel (.xlsx) como filas de texto. Sirve para los
 * reportes que se descargan de otras plataformas (por ejemplo, el inventario
 * de Swayp). Es puro: corre en el navegador y en el runner de Node.
 */
import JSZip from "jszip";

function desescapar(texto: string): string {
  return texto
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

/** El texto de un <si> o <is>: puede venir partido en varios <t>. */
function textoDe(xml: string): string {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => desescapar(m[1])).join("");
}

/** "AB12" → 27 (columna, desde 0). */
function columna(ref: string): number {
  const letras = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  return [...letras].reduce((n, l) => n * 26 + (l.charCodeAt(0) - 64), 0) - 1;
}

export async function leerXlsx(datos: ArrayBuffer | Uint8Array): Promise<string[][]> {
  const zip = await JSZip.loadAsync(datos);
  const compartidos = await zip.file("xl/sharedStrings.xml")?.async("string");
  const textos = compartidos ? [...compartidos.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textoDe(m[1])) : [];

  // La primera hoja según el libro (no siempre se llama sheet1).
  const libro = (await zip.file("xl/workbook.xml")?.async("string")) ?? "";
  const relaciones = (await zip.file("xl/_rels/workbook.xml.rels")?.async("string")) ?? "";
  const rid = /<sheet\b[^>]*r:id="([^"]+)"/.exec(libro)?.[1];
  const destino = rid ? new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${rid}"`).exec(relaciones) : null;
  const ruta = destino ? `xl/${(destino[1] ?? destino[2]).replace(/^\/?xl\//, "")}` : "xl/worksheets/sheet1.xml";
  const hoja = (await zip.file(ruta)?.async("string")) ?? (await zip.file("xl/worksheets/sheet1.xml")?.async("string"));
  if (!hoja) throw new Error("El archivo no tiene hojas.");

  const filas: string[][] = [];
  for (const fila of hoja.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const valores: string[] = [];
    for (const celda of fila[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const atributos = celda[1];
      const dentro = celda[2] ?? "";
      const ref = /\br="([A-Z]+)\d+"/.exec(atributos)?.[1] ?? "";
      const tipo = /\bt="([^"]+)"/.exec(atributos)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(dentro)?.[1];
      let valor = "";
      if (tipo === "s") valor = textos[Number(v)] ?? "";
      else if (tipo === "inlineStr") valor = textoDe(dentro);
      else if (v !== undefined) valor = desescapar(v);
      const i = ref ? columna(ref) : valores.length;
      while (valores.length < i) valores.push("");
      valores[i] = valor.trim();
    }
    filas.push(valores);
  }
  return filas;
}
