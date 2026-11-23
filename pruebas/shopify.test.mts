/**
 * Pruebas de los pedidos que llegan de Shopify.
 *
 * Lo que se cuida: que sólo entre lo que firmó Shopify, que cada canal quede
 * bien marcado (tienda o landing), que lo pagado entre confirmado y que el
 * cliente, el celular y los productos caigan en su lugar.
 */
import assert from "node:assert";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import {
  CANAL_SHOPIFY,
  pedidoDesdeShopify,
  productoDelCatalogo,
  verificarFirmaShopify,
  type PedidoShopify,
} from "../src/lib/shopify.ts";

const CATALOGO = ["SOLUBRE", "CHISGUETE", "CEPILLO VERDE", "CEPILLO DOBLE NEGRO"];
const OPCIONES = { asesor: "YAHAIRA", marcaLanding: "easysell", catalogo: CATALOGO };

const base: PedidoShopify = {
  id: 5551234,
  name: "#1042",
  created_at: "2026-11-24T22:30:00-05:00",
  total_price: "89.90",
  financial_status: "pending",
  tags: "",
  line_items: [
    { title: "Solubre Limpieza para Pisos", quantity: 3 },
    { title: "Cepillo Verde", quantity: 1 },
    { title: "Regalo sorpresa", quantity: 1 },
  ],
  shipping_address: {
    name: "Ana Pérez",
    address1: "Av. Los Olivos 123",
    address2: "Dpto 4",
    city: "Trujillo",
    province: "La Libertad",
    phone: "+51 987 654 321",
    company: "48419937",
  },
};

test("sólo acepta lo que firmó Shopify", () => {
  const cuerpo = JSON.stringify(base);
  const firma = createHmac("sha256", "secreto").update(cuerpo, "utf8").digest("base64");
  assert.equal(verificarFirmaShopify(cuerpo, firma, "secreto"), true);
  assert.equal(verificarFirmaShopify(cuerpo, firma, "otro"), false);
  assert.equal(verificarFirmaShopify(cuerpo + " ", firma, "secreto"), false);
  assert.equal(verificarFirmaShopify(cuerpo, null, "secreto"), false);
});

test("un pedido contra entrega de la tienda entra para llamar, asignado a la asesora", () => {
  const { fila, items } = pedidoDesdeShopify(base, OPCIONES);
  assert.equal(fila.estado, "VOLVER A LLAMAR");
  assert.equal(fila.canal, CANAL_SHOPIFY);
  assert.equal(fila.extra["SHOPIFY ORIGEN"], "TIENDA");
  assert.equal(fila.asesor, "YAHAIRA");
  assert.equal(fila.asignado_a, "YAHAIRA");
  assert.equal(fila.cliente, "Ana Pérez");
  assert.equal(fila.celular, "987654321");
  assert.equal(fila.dni, "48419937");
  assert.equal(fila.destino, "Provincia");
  assert.equal(fila.provincia, "Trujillo");
  assert.equal(fila.monto, 89.9);
  assert.equal(fila.fecha_registro, "2026-11-24");
  assert.equal(fila.shopify_id, "5551234");
  assert.equal(fila.pedido, "3xSOLUBRE, 1xCEPILLO VERDE, 1xRegalo sorpresa");
  assert.deepEqual(items, [
    { producto: "SOLUBRE", cantidad: 3 },
    { producto: "CEPILLO VERDE", cantidad: 1 },
  ]);
});

test("lo pagado entra confirmado y la landing se reconoce por EasySell", () => {
  const { fila } = pedidoDesdeShopify(
    { ...base, financial_status: "paid", tags: "EasySell COD Form, promo", shipping_address: { ...base.shipping_address, city: "Lima", province: "Lima" } },
    OPCIONES,
  );
  assert.equal(fila.estado, "CONFIRMADO");
  assert.equal(fila.pago_completo, "SÍ");
  assert.equal(fila.canal, CANAL_SHOPIFY);
  assert.equal(fila.extra["SHOPIFY ORIGEN"], "LANDING");
  assert.equal(fila.destino, "Lima");
});

test("el producto más específico gana", () => {
  assert.equal(productoDelCatalogo("Cepillo doble negro x2", ["CEPILLO", "CEPILLO DOBLE NEGRO"]), "CEPILLO DOBLE NEGRO");
  assert.equal(productoDelCatalogo("Pack ahorro", CATALOGO), null);
});
