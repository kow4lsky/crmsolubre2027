-- Analítica de asesoras: sólo las asesoras del equipo actual (usuarios con
-- rol asesor o asesor temporal y alias). Antes salían también los nombres
-- viejos de la planilla (MILTON, RENZO…) y el correo del administrador.

/*
 * Una fila por asesora con:
 *   creados        los que ella ingresó al CRM en el rango, por estado inicial
 *                  y por quién cerró la venta (ASESOR / IA)
 *   recibidos      los que le llegaron solos en el rango (Shopify, otra persona)
 *   gestionados    pedidos que no eran nuevos y que ella tocó en el rango, y a
 *                  qué estado los movió
 *   confirmados / entregados en el rango (de su cartera)
 *   pendientes     hoy: VOLVER A LLAMAR + COORDINACIÓN, con su monto
 *   caidos         hoy: CONFIRMADO hace más de `dias_caido` días sin que nadie
 *                  los toque
 */
create or replace function public.analitica_asesoras(ws uuid, desde date, hasta date, dias_caido integer default 2)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  rol text := public.rol_de_venta(ws);
  yo text := upper(coalesce(public.mi_alias(ws), ''));
  limite timestamptz := now() - make_interval(days => greatest(dias_caido, 0));
  resultado jsonb;
begin
  if rol is null then
    raise exception 'No eres parte de este equipo.';
  end if;

  with
  base as (
    select p.*, upper(coalesce(p.creado_por, '')) as creador, upper(coalesce(p.asesor, '')) as duena,
           public.dia_de_lima(p.fecha_creacion) as dia_creado
      from pedidos p
     where p.workspace_id = ws and not coalesce(p.es_prueba, false) and p.tipo_pedido = 'VENTA'
  ),
  creados as (
    select b.creador as alias, b.id, b.monto, b.dia_creado, public.estado_inicial(b.id, b.estado) as inicial,
           coalesce(nullif(upper(b.cerrado_por), ''), 'SIN DATO') as cerro
      from base b
     where b.creador <> '' and b.dia_creado between desde and hasta
  ),
  recibidos as (
    select b.duena as alias, count(*) as n, coalesce(sum(b.monto), 0) as monto
      from base b
     where b.duena <> '' and b.creador is distinct from b.duena and b.dia_creado between desde and hasta
     group by b.duena
  ),
  recibidos_por_canal as (
    select x.alias, jsonb_object_agg(x.canal, x.n) as por_canal
      from (select b.duena as alias, coalesce(nullif(b.canal, ''), 'SIN CANAL') as canal, count(*) as n
              from base b
             where b.duena <> '' and b.creador is distinct from b.duena and b.dia_creado between desde and hasta
             group by 1, 2) x
     group by x.alias
  ),
  toques as (
    select upper(h.usuario) as alias, h.pedido_id, h.accion, h.detalle
      from pedido_historial h
      join base b on b.id = h.pedido_id
     where h.workspace_id = ws
       and h.accion in ('ESTADO', 'EDICIÓN')
       and coalesce(h.usuario, '') <> ''
       and public.dia_de_lima(h.created_at) between desde and hasta
       -- "No nuevos": se crearon antes del día en que los tocó.
       and b.dia_creado < public.dia_de_lima(h.created_at)
  ),
  movidos as (
    select t.alias, substring(t.detalle from 'ESTADO: [^;→]* → ([^;]+)') as a_estado, count(distinct t.pedido_id) as n
      from toques t
     where t.accion = 'ESTADO'
     group by 1, 2
  ),
  -- Sólo las asesoras del equipo de hoy: las que tienen usuario con rol de
  -- asesora y alias. Los nombres viejos de la planilla y el admin no salen.
  alias_de_todas as (
    select distinct upper(trim(m.alias)) as alias
      from workspace_members m
     where m.workspace_id = ws
       and m.rol_venta in ('asesor', 'asesor_temp')
       and m.role not in ('owner', 'admin')
       and coalesce(trim(m.alias), '') <> ''
  ),
  filas as (
    select a.alias,
      jsonb_build_object(
        'alias', a.alias,
        'creados', (select count(*) from creados c where c.alias = a.alias),
        'creados_monto', (select coalesce(sum(c.monto), 0) from creados c where c.alias = a.alias),
        'creados_por_estado', coalesce((select jsonb_object_agg(x.inicial, x.n) from
            (select c.inicial, count(*) as n from creados c where c.alias = a.alias group by 1) x), '{}'::jsonb),
        'creados_por_cierre', coalesce((select jsonb_object_agg(x.cerro, x.n) from
            (select c.cerro, count(*) as n from creados c where c.alias = a.alias group by 1) x), '{}'::jsonb),
        'creados_por_dia', coalesce((select jsonb_object_agg(x.dia_creado, x.n) from
            (select c.dia_creado, count(*) as n from creados c where c.alias = a.alias group by 1) x), '{}'::jsonb),
        'recibidos', coalesce((select r.n from recibidos r where r.alias = a.alias), 0),
        'recibidos_por_canal', coalesce((select r.por_canal from recibidos_por_canal r where r.alias = a.alias), '{}'::jsonb),
        'gestionados', (select count(distinct t.pedido_id) from toques t where t.alias = a.alias),
        'movidos_a', coalesce((select jsonb_object_agg(coalesce(m.a_estado, '?'), m.n) from movidos m where m.alias = a.alias), '{}'::jsonb),
        'confirmados', (select count(*) from base b where b.duena = a.alias
                          and public.dia_de_lima(b.fecha_confirmado) between desde and hasta),
        'entregados', (select count(*) from base b where b.duena = a.alias
                          and public.dia_de_lima(b.fecha_entregado) between desde and hasta),
        'entregados_monto', (select coalesce(sum(b.monto), 0) from base b where b.duena = a.alias
                          and public.dia_de_lima(b.fecha_entregado) between desde and hasta),
        'pendientes', (select jsonb_build_object(
            'total', count(*),
            'monto', coalesce(sum(b.monto), 0),
            'volver_a_llamar', count(*) filter (where b.estado = 'VOLVER A LLAMAR'),
            'coordinacion', count(*) filter (where b.estado = 'COORDINACIÓN'),
            'llamada_vencida', count(*) filter (where b.prox_llamada_at < now()),
            'sin_llamada', count(*) filter (where b.prox_llamada_at is null),
            'mas_de_7_dias', count(*) filter (where b.fecha_creacion < now() - interval '7 days'))
          from base b where b.duena = a.alias and b.estado in ('VOLVER A LLAMAR', 'COORDINACIÓN')),
        'caidos', (select jsonb_build_object(
            'total', count(*),
            'monto', coalesce(sum(b.monto), 0),
            'codigos', coalesce((array_agg(b.codigo order by b.codigo_num))[1:40], '{}'))
          from base b where b.duena = a.alias and b.estado = 'CONFIRMADO'
            and coalesce(b.fecha_estado, b.fecha_creacion) < limite
            and coalesce(b.ultima_gestion, b.fecha_creacion) < limite)
      ) as datos
      from alias_de_todas a
     where rol in ('admin', 'encargado') or a.alias = yo
  )
  select coalesce(jsonb_agg(f.datos order by f.alias), '[]'::jsonb) into resultado from filas f;

  return resultado;
end;
$$;

