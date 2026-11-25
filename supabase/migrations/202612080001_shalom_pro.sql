-- Shalom PRO como una conexión más (Configuración → Conexiones).
--
-- Shalom no tiene API pública: el CRM usa la sesión que la persona abre en
-- pro.shalom.pe con "Recuérdame" (la cookie se guarda cifrada, como las demás
-- claves). Con ella registra los envíos y, cada 12 horas, trae su estado.

alter table public.integraciones drop constraint if exists integraciones_provider_check;
alter table public.integraciones
  add constraint integraciones_provider_check
  check (provider in ('openai', 'ycloud', 'zernio', 'shopify', 'swayp', 'flujos', 'shalom'));
