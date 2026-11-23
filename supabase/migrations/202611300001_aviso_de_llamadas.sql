-- Aviso push de la próxima llamada, aunque el CRM esté cerrado.
--
-- El reloj (pg_cron, o cualquier servicio que llame a /api/cron/tareas cada
-- minuto) busca las llamadas que vencieron y manda una notificación al
-- celular o la compu de quien la programó. `recordatorio_avisado_at` marca que
-- ya se mandó: así no llega el mismo aviso cada minuto.
alter table public.pedidos add column if not exists recordatorio_avisado_at timestamptz;

create index if not exists pedidos_avisos_pendientes_idx
  on public.pedidos (prox_llamada_at)
  where recordatorio_avisado_at is null and not recordatorio_visto and recordatorio_de is not null;

-- Si la llamada se reprograma, el aviso vuelve a quedar pendiente.
create or replace function public.pedidos_reprogramar_aviso()
returns trigger language plpgsql as $$
begin
  if new.prox_llamada_at is distinct from old.prox_llamada_at then
    new.recordatorio_avisado_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists pedidos_reprogramar_aviso on public.pedidos;
create trigger pedidos_reprogramar_aviso
  before update on public.pedidos
  for each row execute function public.pedidos_reprogramar_aviso();

-- El historial tampoco anota esta marca interna.
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
        'recordatorio_avisado_at'
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
