/**
 * Los distritos de Lima Metropolitana y del Callao con su código de ubigeo
 * (INEI), que Swayp pide en cada guía (ciudadDestinatario). Es puro.
 */

export type Distrito = { nombre: string; ubigeo: string };

export const DISTRITOS_LIMA: Distrito[] = [
  { nombre: "Lima (Cercado)", ubigeo: "150101" },
  { nombre: "Ancón", ubigeo: "150102" },
  { nombre: "Ate", ubigeo: "150103" },
  { nombre: "Barranco", ubigeo: "150104" },
  { nombre: "Breña", ubigeo: "150105" },
  { nombre: "Carabayllo", ubigeo: "150106" },
  { nombre: "Chaclacayo", ubigeo: "150107" },
  { nombre: "Chorrillos", ubigeo: "150108" },
  { nombre: "Cieneguilla", ubigeo: "150109" },
  { nombre: "Comas", ubigeo: "150110" },
  { nombre: "El Agustino", ubigeo: "150111" },
  { nombre: "Independencia", ubigeo: "150112" },
  { nombre: "Jesús María", ubigeo: "150113" },
  { nombre: "La Molina", ubigeo: "150114" },
  { nombre: "La Victoria", ubigeo: "150115" },
  { nombre: "Lince", ubigeo: "150116" },
  { nombre: "Los Olivos", ubigeo: "150117" },
  { nombre: "Lurigancho (Chosica)", ubigeo: "150118" },
  { nombre: "Lurín", ubigeo: "150119" },
  { nombre: "Magdalena del Mar", ubigeo: "150120" },
  { nombre: "Pueblo Libre", ubigeo: "150121" },
  { nombre: "Miraflores", ubigeo: "150122" },
  { nombre: "Pachacámac", ubigeo: "150123" },
  { nombre: "Pucusana", ubigeo: "150124" },
  { nombre: "Puente Piedra", ubigeo: "150125" },
  { nombre: "Punta Hermosa", ubigeo: "150126" },
  { nombre: "Punta Negra", ubigeo: "150127" },
  { nombre: "Rímac", ubigeo: "150128" },
  { nombre: "San Bartolo", ubigeo: "150129" },
  { nombre: "San Borja", ubigeo: "150130" },
  { nombre: "San Isidro", ubigeo: "150131" },
  { nombre: "San Juan de Lurigancho", ubigeo: "150132" },
  { nombre: "San Juan de Miraflores", ubigeo: "150133" },
  { nombre: "San Luis", ubigeo: "150134" },
  { nombre: "San Martín de Porres", ubigeo: "150135" },
  { nombre: "San Miguel", ubigeo: "150136" },
  { nombre: "Santa Anita", ubigeo: "150137" },
  { nombre: "Santa María del Mar", ubigeo: "150138" },
  { nombre: "Santa Rosa", ubigeo: "150139" },
  { nombre: "Santiago de Surco", ubigeo: "150140" },
  { nombre: "Surquillo", ubigeo: "150141" },
  { nombre: "Villa El Salvador", ubigeo: "150142" },
  { nombre: "Villa María del Triunfo", ubigeo: "150143" },
  { nombre: "Callao", ubigeo: "070101" },
  { nombre: "Bellavista", ubigeo: "070102" },
  { nombre: "Carmen de la Legua Reynoso", ubigeo: "070103" },
  { nombre: "La Perla", ubigeo: "070104" },
  { nombre: "La Punta", ubigeo: "070105" },
  { nombre: "Ventanilla", ubigeo: "070106" },
  { nombre: "Mi Perú", ubigeo: "070107" },
];

export const normalizar = (texto: string) =>
  texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Cómo se escriben de verdad algunos distritos. */
const APODOS: Record<string, string> = {
  SURCO: "Santiago de Surco",
  "SANTIAGO DE SURCO": "Santiago de Surco",
  SJL: "San Juan de Lurigancho",
  SJM: "San Juan de Miraflores",
  SMP: "San Martín de Porres",
  VES: "Villa El Salvador",
  VMT: "Villa María del Triunfo",
  CERCADO: "Lima (Cercado)",
  "CERCADO DE LIMA": "Lima (Cercado)",
  "LIMA CERCADO": "Lima (Cercado)",
  LIMA: "Lima (Cercado)",
  MAGDALENA: "Magdalena del Mar",
  CHOSICA: "Lurigancho (Chosica)",
  LURIGANCHO: "Lurigancho (Chosica)",
  PACHACAMAC: "Pachacámac",
  "CARMEN DE LA LEGUA": "Carmen de la Legua Reynoso",
  "CALLAO CERCADO": "Callao",
  "JESUS MARIA": "Jesús María",
};

/**
 * El distrito de Lima o Callao de un texto ("santiago de surco", "SJL",
 * "La Victoria"). `seguro` es false si se adivinó dentro de una frase larga.
 */
export function sugerirDistrito(...textos: (string | null | undefined)[]): { distrito: Distrito | null; seguro: boolean } {
  for (const texto of textos) {
    const limpio = normalizar(texto ?? "");
    if (!limpio) continue;
    const apodo = APODOS[limpio];
    const exacto = DISTRITOS_LIMA.find((d) => normalizar(d.nombre) === limpio || normalizar(d.nombre.replace(/\s*\(.*\)/, "")) === limpio || d.nombre === apodo);
    if (exacto) return { distrito: exacto, seguro: true };
  }
  // Dentro de una frase (por ejemplo, la dirección): el nombre más largo que aparezca.
  for (const texto of textos) {
    const limpio = ` ${normalizar(texto ?? "")} `;
    const candidatos = DISTRITOS_LIMA.filter((d) => {
      const nombre = normalizar(d.nombre.replace(/\s*\(.*\)/, ""));
      return nombre.length > 4 && limpio.includes(` ${nombre} `);
    }).sort((a, b) => b.nombre.length - a.nombre.length);
    if (candidatos[0]) return { distrito: candidatos[0], seguro: false };
  }
  return { distrito: null, seguro: false };
}
