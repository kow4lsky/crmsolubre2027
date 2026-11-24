-- Pedidos pendientes: ventas que llegan de afuera (las que cierra la IA en
-- Flujos Inteligentes) y esperan que alguien las revise y las programe.
--
-- No son pedidos todavía: no tienen código WED ni cuentan en nada. Al
-- "Programar", se abre la ficha con los datos ya completados y, al guardar,
-- nace el pedido y la fila queda vinculada a él.

create table if not exists public.pedidos_pendientes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  origen text not null default 'FLUJOS',
  -- El id del pedido en el sistema de origen: con él nunca entra dos veces.
  externo_id text not null,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'programado', 'descartado')),
  cliente text,
  celular text,
  monto numeric(12, 2),
  resumen text,
  -- Los datos ya traducidos a campos del pedido, listos para la ficha.
  propuesta jsonb not null default '{}'::jsonb,
  -- Lo que mandó el origen, completo.
  datos jsonb not null default '{}'::jsonb,
  creado_en_origen timestamptz,
  pedido_id uuid references public.pedidos(id) on delete set null,
  resuelto_por uuid references auth.users(id) on delete set null,
  resuelto_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, origen, externo_id)
);

create index if not exists pedidos_pendientes_estado_idx
  on public.pedidos_pendientes (workspace_id, estado, creado_en_origen desc);

alter table public.pedidos_pendientes enable row level security;

-- Lo ve y lo resuelve cualquiera del equipo con la sección habilitada. Los
-- crea sólo el servidor (la sincronización con Flujos).
drop policy if exists "pedidos_pendientes: ver" on public.pedidos_pendientes;
create policy "pedidos_pendientes: ver" on public.pedidos_pendientes for select to authenticated
  using (public.is_workspace_member(workspace_id));

drop policy if exists "pedidos_pendientes: resolver" on public.pedidos_pendientes;
create policy "pedidos_pendientes: resolver" on public.pedidos_pendientes for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- Hasta dónde se revisó cada origen, para no pedirle todo de nuevo cada vez.
create table if not exists public.sincronizaciones (
  clave text primary key,
  ultima_at timestamptz,
  ultimo_error text,
  updated_at timestamptz not null default now()
);
alter table public.sincronizaciones enable row level security;
-- Sin políticas: sólo el servidor.

-- Flujos como una conexión más.
alter table public.integraciones drop constraint if exists integraciones_provider_check;
alter table public.integraciones
  add constraint integraciones_provider_check
  check (provider in ('openai', 'ycloud', 'zernio', 'shopify', 'swayp', 'flujos'));
