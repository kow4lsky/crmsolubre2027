-- Próxima llamada con fecha y hora, y un solo canal SHOPIFY.

/* --------------------------------------------- recordatorio de llamada */

-- `prox_llamada` (sólo la fecha) queda por los pedidos de la planilla. Lo nuevo
-- guarda el momento exacto y a quién avisarle: a quien lo programó.
alter table public.pedidos
  add column if not exists prox_llamada_at timestamptz,
  add column if not exists recordatorio_de uuid references auth.users(id) on delete set null,
  add column if not exists recordatorio_visto boolean not null default false;

-- Lo que busca el aviso cada minuto: los míos, vencidos y sin ver.
create index if not exists pedidos_recordatorios_idx
  on public.pedidos (recordatorio_de, prox_llamada_at)
  where not recordatorio_visto;

-- El historial no anota los campos internos del aviso: "Ya llamé" no es un
-- cambio del pedido. La próxima llamada se sigue viendo por `prox_llamada`.
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
        'codigo_num', 'recordatorio_de', 'recordatorio_visto', 'prox_llamada_at'
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

/* --------------------------------------------------- canal SHOPIFY */

-- Tienda y landing son el mismo canal. De dónde vino queda en extra, por si
-- algún día hace falta separarlo en la analítica.
update public.pedidos
set extra = extra || jsonb_build_object(
      'SHOPIFY ORIGEN',
      case when canal = 'SHOPIFY LANDING' then 'LANDING' else 'TIENDA' end
    ),
    canal = 'SHOPIFY'
where canal in ('SHOPIFY TIENDA', 'SHOPIFY LANDING');
