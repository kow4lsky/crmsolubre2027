import assert from "node:assert/strict";
import test from "node:test";

import { conversion, rangoDe, soles, sumarAnuncios, totalesDelRango, type AnaliticaEmpresa, type DiaDeEmpresa } from "../src/lib/analitica.ts";
import { rangoDelDia, resumirDiaDeFlujos } from "../src/lib/flujos.ts";

// 24 nov 2026, 22:00 en Lima = 25 nov 03:00 UTC: sigue siendo 24 en Lima.
const ahora = new Date("2026-11-25T03:00:00Z");
const nada = { desde: "", hasta: "" };

test("los periodos se cuentan en días de Lima", () => {
  assert.deepEqual(rangoDe("hoy", ahora, nada), { desde: "2026-11-24", hasta: "2026-11-24" });
  assert.deepEqual(rangoDe("ayer", ahora, nada), { desde: "2026-11-23", hasta: "2026-11-23" });
  assert.deepEqual(rangoDe("7dias", ahora, nada), { desde: "2026-11-18", hasta: "2026-11-24" });
  assert.deepEqual(rangoDe("mes", ahora, nada), { desde: "2026-11-01", hasta: "2026-11-24" });
  assert.deepEqual(rangoDe("mes_pasado", ahora, nada), { desde: "2026-10-01", hasta: "2026-10-31" });
  assert.deepEqual(rangoDe("propio", ahora, { desde: "2026-11-20", hasta: "2026-11-10" }), { desde: "2026-11-10", hasta: "2026-11-20" });
});

test("soles y porcentajes", () => {
  assert.equal(soles(1234.5), "S/ 1,234.5");
  assert.equal(soles(null), "S/ 0");
  assert.equal(conversion(1, 4), "25 %");
  assert.equal(conversion(3, 0), "—");
});

const dia = (d: Partial<DiaDeEmpresa>): DiaDeEmpresa => ({
  dia: "2026-11-24", registrados: 0, registrados_monto: 0, por_canal: {}, por_cierre: {}, confirmados: 0, entregados: 0,
  entregados_monto: 0, flujos: null, ia_llegaron: 0, ia_programadas: 0, ia_descartadas: 0, ...d,
});

test("suma el periodo y los anuncios", () => {
  const empresa = {
    dias: [
      dia({ registrados: 3, registrados_monto: 200, por_cierre: { IA: 1, ASESOR: 2 }, entregados: 1, entregados_monto: 89.9 }),
      dia({ dia: "2026-11-23", registrados: 2, por_cierre: { IA: 2 }, confirmados: 4,
        flujos: { leads: 10, leads_por_origen: {}, leads_por_anuncio: { Pisos: 6, Madera: 1 }, ventas: 2, ventas_ia: 2, monto: 0, ventas_por_etapa: {}, actualizado_at: "" } }),
    ],
    hoy: {} as AnaliticaEmpresa["hoy"],
    estados_del_rango: {},
  } as AnaliticaEmpresa;
  const t = totalesDelRango(empresa);
  assert.equal(t.registrados, 5);
  assert.deepEqual(t.porCierre, { IA: 3, ASESOR: 2 });
  assert.equal(t.confirmados, 4);
  assert.deepEqual(sumarAnuncios(empresa.dias), [["Pisos", 6], ["Madera", 1]]);
});

test("Flujos: resume los leads del día por origen y anuncio, y las ventas de ese día", () => {
  assert.deepEqual(rangoDelDia("2026-11-24"), { date_from: "2026-11-24T00:00:00-05:00", date_to: "2026-11-24T23:59:59-05:00" });
  const leads = [
    { id: "1", anuncio: { headline: "Recupera la apariencia de tus pisos ✨" } },
    { id: "2", anuncio: { headline: "Recupera la apariencia de tus pisos ✨" } },
    { id: "3", anuncio: null },
  ];
  const metricas = {
    pedidos: 68,
    creados_por_ia: 12,
    por_dia: [{ dia: "2026-11-23", monto: 1338.72, pedidos: 16 }, { dia: "2026-11-24", monto: 100, pedidos: 2 }],
    por_etapa: [{ etapa: "registrado", pedidos: 10 }, { etapa: "por-registrar", pedidos: 6 }],
  };
  const r = resumirDiaDeFlujos("2026-11-23", leads, metricas);
  assert.equal(r.leads, 3);
  assert.deepEqual(r.leads_por_origen, { Anuncio: 2, Directo: 1 });
  assert.deepEqual(r.leads_por_anuncio, { "Recupera la apariencia de tus pisos ✨": 2 });
  assert.equal(r.ventas, 16);
  assert.equal(r.ventas_ia, 12);
  assert.equal(r.monto, 1338.72);
  assert.deepEqual(r.ventas_por_etapa, { registrado: 10, "por-registrar": 6 });
});
