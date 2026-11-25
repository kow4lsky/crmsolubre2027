-- Un solo estado en la tabla, pedidos despachados bloqueados para las asesoras
-- y un registro de lo que pasa con las conexiones (Swayp, Shalom).

/* ------------------------------------------- pedidos que ya salieron */

-- Un pedido sale cuando tiene guía de Swayp o tracking. Igual que
-- `pedidoDespachado()` en src/lib/pedidos.ts.
create or replace function public.pedido_despachado(tracking text, guia_swayp text)
returns boolean language sql immutable as $$
  select coalesce(trim(tracking), '') <> '' or coalesce(trim(guia_swayp), '') <> '';
$$;

-- La asesora ya no lo cambia: sólo añade notas. Para lo demás pide
-- autorización y el administrador lo aplica. Admin, encargado y los trabajos
-- del servidor (Swayp, Shalom) siguen pudiendo.
create or replace function public.pedidos_bloquear_despachados()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  cambiados text;
begin
  if auth.uid() is null or current_setting('crm.importando', true) = 'on' then
    return new;
  end if;
  if public.rol_de_venta(new.workspace_id) not in ('asesor', 'asesor_temp') then
    return new;
  end if;
  if not public.pedido_despachado(old.tracking, old.guia_swayp) then
    return new;
  end if;

  select string_agg(n.key, ', ') into cambiados
  from jsonb_each(to_jsonb(new)) n
  join jsonb_each(to_jsonb(old)) o using (key)
  where n.value is distinct from o.value
    and n.key not in (
      'nota', 'updated_at', 'ultima_gestion', 'busqueda', 'fecha_estado', 'fecha_primera_gestion',
      'codigo_num', 'recordatorio_de', 'recordatorio_visto', 'recordatorio_avisado_at',
      'guia_swayp', 'estado_swayp'
    );

  if cambiados is not null then
    raise exception 'Este pedido ya salió (tiene guía o tracking): sólo puedes añadir notas. Para cambiar algo, pide autorización al administrador.';
  end if;
  return new;
end;
$$;

drop trigger if exists pedidos_bloquear_despachados on public.pedidos;
create trigger pedidos_bloquear_despachados
  before update on public.pedidos
  for each row execute function public.pedidos_bloquear_despachados();

-- Los productos de un pedido que ya salió tampoco.
create or replace function public.pedido_items_bloquear_despachados()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  fila public.pedidos;
begin
  if auth.uid() is null or current_setting('crm.importando', true) = 'on' then
    return coalesce(new, old);
  end if;
  select * into fila from public.pedidos where id = coalesce(new.pedido_id, old.pedido_id);
  if fila.id is not null
     and public.rol_de_venta(fila.workspace_id) in ('asesor', 'asesor_temp')
     and public.pedido_despachado(fila.tracking, fila.guia_swayp) then
    raise exception 'Este pedido ya salió (tiene guía o tracking): sus productos ya no se cambian. Pide autorización al administrador.';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists pedido_items_bloquear_despachados on public.pedido_items;
create trigger pedido_items_bloquear_despachados
  before insert or update or delete on public.pedido_items
  for each row execute function public.pedido_items_bloquear_despachados();

-- "Pedir cambio" de datos (no de estado): la solicitud va con el mismo estado
-- de ida y vuelta, y el motivo cuenta qué hay que cambiar.

/* ------------------------------------------ registro de las conexiones */

-- Cada problema de una conexión (sesión vencida, aviso con firma inválida,
-- guía sin pedido…), con fecha y hora. Sólo lo escribe el servidor.
create table if not exists public.conexion_registro (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  servicio text not null,
  nivel text not null default 'error' check (nivel in ('info', 'aviso', 'error')),
  mensaje text not null,
  datos jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists conexion_registro_idx on public.conexion_registro (workspace_id, created_at desc);

alter table public.conexion_registro enable row level security;

drop policy if exists "conexion_registro: ver" on public.conexion_registro;
create policy "conexion_registro: ver" on public.conexion_registro for select to authenticated
  using (public.rol_de_venta(workspace_id) in ('admin', 'encargado'));
