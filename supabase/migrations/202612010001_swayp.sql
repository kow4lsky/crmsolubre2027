-- Swayp (motorizado de Lima): la guía de cada pedido y el historial de envíos.

/* ------------------------------------------------------------- la guía */

-- El número de GUÍA que da Swayp. Lo escribe el sistema (al importar, al recibir
-- un aviso o al crear la guía): nadie lo edita a mano.
alter table public.pedidos
  add column if not exists guia_swayp text,
  add column if not exists estado_swayp text;

create index if not exists pedidos_guia_swayp_idx on public.pedidos (workspace_id, guia_swayp);

-- Las guías que vinieron de la planilla (columna GUIA SWAYP).
update public.pedidos
set guia_swayp = nullif(trim(coalesce(extra ->> 'GUIA SWAYP', extra ->> 'GUÍA SWAYP')), '')
where guia_swayp is null
  and nullif(trim(coalesce(extra ->> 'GUIA SWAYP', extra ->> 'GUÍA SWAYP')), '') is not null;

-- Desde la pantalla no se puede tocar: la guía es de Swayp.
create or replace function public.pedidos_proteger_guia()
returns trigger language plpgsql as $$
begin
  if auth.uid() is null or current_setting('crm.importando', true) = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.guia_swayp := null;
    new.estado_swayp := null;
  else
    new.guia_swayp := old.guia_swayp;
    new.estado_swayp := old.estado_swayp;
  end if;
  return new;
end;
$$;

drop trigger if exists pedidos_proteger_guia on public.pedidos;
create trigger pedidos_proteger_guia
  before insert or update on public.pedidos
  for each row execute function public.pedidos_proteger_guia();

/* ------------------------------------------------- historial de envíos */

-- Cada aviso de un courier, tal como llegó. Es la base de la analítica de
-- envíos (entregados, devoluciones, costos) y sirve de prueba ante un reclamo.
create table if not exists public.envio_eventos (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Puede quedar vacío si todavía no se sabe de qué pedido es la guía.
  pedido_id uuid references public.pedidos(id) on delete set null,
  courier text not null default 'SWAYP',
  guia text not null,
  estado_codigo text,
  estado text,
  comentario text,
  -- El id del aviso que manda Swayp: con él un aviso repetido no se guarda dos veces.
  entrega_id text,
  costo numeric(12, 2),
  recaudo numeric(12, 2),
  datos jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists envio_eventos_entrega_key on public.envio_eventos (courier, entrega_id);
create index if not exists envio_eventos_guia_idx on public.envio_eventos (workspace_id, guia, created_at desc);
create index if not exists envio_eventos_pedido_idx on public.envio_eventos (pedido_id, created_at desc);

alter table public.envio_eventos enable row level security;

-- Se ve si se ve el pedido. Los que no tienen pedido, sólo el admin.
drop policy if exists "envio_eventos: ver" on public.envio_eventos;
create policy "envio_eventos: ver" on public.envio_eventos for select to authenticated
  using (
    public.rol_de_venta(workspace_id) = 'admin'
    or exists (select 1 from public.pedidos p where p.id = pedido_id)
  );
-- Sin políticas de escritura: sólo el servidor (los avisos) escribe acá.

/* ------------------------------------------------------- la conexión */

alter table public.integraciones drop constraint if exists integraciones_provider_check;
alter table public.integraciones
  add constraint integraciones_provider_check
  check (provider in ('openai', 'ycloud', 'zernio', 'shopify', 'swayp'));

/* -------------------------------------------- historial sin ruido */

-- El estado de Swayp se ve en su propio historial de envíos; la guía sí se anota.
create or replace function public.pedidos_anotar_historial()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  cambios text := '';
  campo record;
  quien text;
begin
  if current_setting('crm.importando', true) = 'on' then
    return new;
  end if;

  quien := nullif(public.mi_alias(new.workspace_id), '');
  if quien is null and auth.uid() is not null then
    select email into quien from auth.users where id = auth.uid();
  end if;

  if tg_op = 'INSERT' then
    insert into public.pedido_historial (pedido_id, workspace_id, usuario_id, usuario, accion, detalle)
    values (new.id, new.workspace_id, auth.uid(), quien, 'CREADO', 'Estado inicial: ' || new.estado);
    return new;
  end if;

  for campo in
    select n.key, o.value as antes, n.value as despues
    from jsonb_each(to_jsonb(new)) n
    join jsonb_each(to_jsonb(old)) o using (key)
    where n.value is distinct from o.value
      and n.key not in (
        'updated_at', 'ultima_gestion', 'busqueda', 'fecha_estado', 'fecha_primera_gestion',
        'codigo_num', 'recordatorio_de', 'recordatorio_visto', 'prox_llamada_at',
        'recordatorio_avisado_at', 'estado_swayp'
      )
  loop
    cambios := cambios
      || case when cambios = '' then '' else '; ' end
      || upper(replace(campo.key, '_', ' ')) || ': '
      || coalesce(campo.antes #>> '{}', '—') || ' → ' || coalesce(campo.despues #>> '{}', '—');
  end loop;

  if cambios <> '' then
    insert into public.pedido_historial (pedido_id, workspace_id, usuario_id, usuario, accion, detalle)
    values (
      new.id, new.workspace_id, auth.uid(), quien,
      case when new.estado is distinct from old.estado then 'ESTADO' else 'EDICIÓN' end,
      cambios
    );
  end if;
  return new;
end;
$$;
