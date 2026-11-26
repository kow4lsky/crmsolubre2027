-- Llamadas: dos opciones más (Coordinación y Confirmado), el pedido del lead
-- sólo si es del mismo día en adelante (una compra de otra fecha no lo cierra)
-- y la revisión de duplicados antes de crear la ficha.

alter table public.llamadas drop constraint if exists llamadas_llamada_check;
alter table public.llamadas
  add constraint llamadas_llamada_check
  check (llamada in ('PRIMERA', 'SEGUNDA', 'NC', 'COORDINACION', 'CONFIRMADO'));

create or replace function public.marcar_llamada(ws uuid, lead text, valor text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.rol_de_venta(ws) is null then
    raise exception 'No eres parte de este equipo.';
  end if;
  if valor is not null and valor not in ('PRIMERA', 'SEGUNDA', 'NC', 'COORDINACION', 'CONFIRMADO') then
    raise exception 'Llamada no válida.';
  end if;
  update public.llamadas
  set llamada = valor,
      llamada_por = case when valor is null then null else auth.uid() end,
      llamada_por_alias = case when valor is null then null else nullif(public.mi_alias(ws), '') end,
      llamada_at = case when valor is null then null else now() end
  where workspace_id = ws and lead_id = lead;
end;
$$;

-- El pedido del lead: el enlazado, o uno del mismo celular registrado desde el
-- día del lead. Aparte, la última compra anterior (para saber que ya es cliente).
drop function if exists public.llamadas_del_dia(uuid, date);
create or replace function public.llamadas_del_dia(ws uuid, dia date)
returns table (
  lead_id text, nombre text, celular text, producto text, etapa text, etiquetas jsonb, anuncio text,
  creado_en timestamptz, llamada text, llamada_por_alias text, llamada_at timestamptz,
  pedido_id uuid, pedido_codigo text, pedido_estado text, pedido_asesor text,
  anterior_codigo text, anterior_fecha date
)
language sql stable security definer set search_path = public as $$
  select l.lead_id, l.nombre, l.celular, l.producto, l.etapa, l.etiquetas, l.anuncio,
         l.creado_en, l.llamada, l.llamada_por_alias, l.llamada_at,
         p.id, p.codigo, p.estado, p.asesor,
         a.codigo, a.fecha_registro
  from public.llamadas l
  left join lateral (
    select x.id, x.codigo, x.estado, x.asesor
    from public.pedidos x
    where x.workspace_id = ws
      and (x.id = l.pedido_id
           or (l.pedido_id is null and l.celular is not null and x.celular = l.celular and x.fecha_registro >= l.dia))
    order by (x.id = l.pedido_id) desc, x.created_at desc
    limit 1
  ) p on true
  left join lateral (
    select y.codigo, y.fecha_registro
    from public.pedidos y
    where y.workspace_id = ws and l.celular is not null and y.celular = l.celular and y.fecha_registro < l.dia
    order by y.fecha_registro desc
    limit 1
  ) a on true
  where l.workspace_id = ws and l.dia = llamadas_del_dia.dia
    and public.rol_de_venta(ws) is not null
  order by l.creado_en desc;
$$;

-- Antes de crear una ficha: los pedidos de ese celular (de cualquier asesora),
-- para no crear dos veces el mismo pedido.
create or replace function public.pedidos_del_celular(ws uuid, cel text)
returns table (id uuid, codigo text, fecha_registro date, estado text, asesor text, pedido text)
language sql stable security definer set search_path = public as $$
  select p.id, p.codigo, p.fecha_registro, p.estado, p.asesor, p.pedido
  from public.pedidos p
  where p.workspace_id = ws
    and public.rol_de_venta(ws) is not null
    and length(regexp_replace(coalesce(cel, ''), '\D', '', 'g')) >= 9
    and p.celular = right(regexp_replace(cel, '\D', '', 'g'), 9)
  order by p.fecha_registro desc, p.created_at desc
  limit 10;
$$;
