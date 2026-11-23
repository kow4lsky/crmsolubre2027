-- Pedidos que llegan solos desde Shopify (tienda y landing de EasySell).
--
-- `shopify_id` es el id del pedido en Shopify: con él un pedido nunca entra dos
-- veces, aunque Shopify reintente el aviso. Los pedidos cargados a mano o de la
-- planilla lo tienen vacío (los vacíos no chocan entre sí).
alter table public.pedidos add column if not exists shopify_id text;

create unique index if not exists pedidos_shopify_id_key
  on public.pedidos (workspace_id, shopify_id);

-- Shopify como una conexión más en Configuración → Conexiones.
alter table public.integraciones drop constraint if exists integraciones_provider_check;
alter table public.integraciones
  add constraint integraciones_provider_check
  check (provider in ('openai', 'ycloud', 'zernio', 'shopify'));
