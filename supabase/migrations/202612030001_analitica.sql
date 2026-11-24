-- Analítica: cómo va cada asesora y cómo va la empresa.
--
-- Todo se calcula en Postgres a partir de lo que ya se guarda:
--   * pedidos: quién lo creó (creado_por), de quién es (asesor), si lo cerró
--     la IA o una asesora (cerrado_por), y las fechas de cada paso;
--   * pedido_historial: el estado con que se creó ("Estado inicial: …") y
--     cada cambio que hizo cada persona después;
--   * pedidos_pendientes: las ventas de la IA en Flujos y si se programaron;
--   * flujos_diario (nueva): cuántos leads entraron a Flujos cada día y
--     cuántas ventas cerró ahí la IA. La llena el reloj del CRM.
--
-- Los días son de Lima. Una asesora sólo ve sus propios números; el
-- administrador y el encargado ven los de todas.

create table if not exists public.flujos_diario (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  dia date not null,
  leads integer not null default 0,
  -- {"Anuncio": 120, "Directo": 30}
  leads_por_origen jsonb not null default '{}'::jsonb,
  -- {"Recupera la apariencia de tus pisos": 80, …}
  leads_por_anuncio jsonb not null default '{}'::jsonb,
  ventas integer not null default 0,
  ventas_ia integer not null default 0,
  monto numeric(12,2) not null default 0,
  -- {"registrado": 48, "por-registrar": 19}
  ventas_por_etapa jsonb not null default '{}'::jsonb,
  actualizado_at timestamptz not null default now(),
  primary key (workspace_id, dia)
);

alter table public.flujos_diario enable row level security;
drop policy if exists "flujos_diario: ver" on public.flujos_diario;
create policy "flujos_diario: ver" on public.flujos_diario for select to authenticated
  using (public.rol_de_venta(workspace_id) in ('admin', 'encargado'));
grant select on public.flujos_diario to authenticated;
grant all on public.flujos_diario to service_role;

-- El día de Lima de un momento.
create or replace function public.dia_de_lima(momento timestamptz)
returns date language sql immutable as $$
  select (momento at time zone 'America/Lima')::date
$$;

-- El estado con que se creó un pedido. Los importados de la planilla no
-- tienen historial: para ellos se usa el estado de hoy.
create or replace function public.estado_inicial(pedido uuid, estado_actual text)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select substring(h.detalle from 'Estado inicial: (.*)$')
       from pedido_historial h
      where h.pedido_id = pedido and h.accion = 'CREADO'
      order by h.created_at limit 1),
    estado_actual
  )
$$;

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
     where p.workspace_id = ws and not coalesce(p.es_prueba, false)
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
  alias_de_todas as (
    select alias from creados
    union select alias from recibidos
    union select alias from toques
    union select duena from base where duena <> '' and estado in ('VOLVER A LLAMAR', 'COORDINACIÓN', 'CONFIRMADO')
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

/*
 * La empresa, día por día del rango: lo que se registró (por canal y por quién
 * cerró), lo que se confirmó y entregó, y lo de Flujos (leads que entraron,
 * ventas de la IA, cuántas llegaron al CRM). Más la foto de hoy: cuánta plata
 * hay en pedidos sin confirmar y en confirmados caídos.
 */
create or replace function public.analitica_empresa(ws uuid, desde date, hasta date, dias_caido integer default 2)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  limite timestamptz := now() - make_interval(days => greatest(dias_caido, 0));
  dias jsonb;
  hoy jsonb;
  estados jsonb;
begin
  if coalesce(public.rol_de_venta(ws), '') not in ('admin', 'encargado') then
    raise exception 'Solo el administrador o el encargado ven la analítica de la empresa.';
  end if;

  with
  base as (
    select p.*, public.dia_de_lima(p.fecha_creacion) as dia_creado
      from pedidos p
     where p.workspace_id = ws and not coalesce(p.es_prueba, false)
  ),
  calendario as (
    select d::date as dia from generate_series(desde, hasta, interval '1 day') d
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'dia', c.dia,
      'registrados', (select count(*) from base b where b.dia_creado = c.dia),
      'registrados_monto', (select coalesce(sum(b.monto), 0) from base b where b.dia_creado = c.dia),
      'por_canal', coalesce((select jsonb_object_agg(x.canal, x.n) from
          (select coalesce(nullif(b.canal, ''), 'SIN CANAL') as canal, count(*) as n
             from base b where b.dia_creado = c.dia group by 1) x), '{}'::jsonb),
      'por_cierre', coalesce((select jsonb_object_agg(x.cerro, x.n) from
          (select coalesce(nullif(upper(b.cerrado_por), ''), 'SIN DATO') as cerro, count(*) as n
             from base b where b.dia_creado = c.dia group by 1) x), '{}'::jsonb),
      'confirmados', (select count(*) from base b where public.dia_de_lima(b.fecha_confirmado) = c.dia),
      'entregados', (select count(*) from base b where public.dia_de_lima(b.fecha_entregado) = c.dia),
      'entregados_monto', (select coalesce(sum(b.monto), 0) from base b where public.dia_de_lima(b.fecha_entregado) = c.dia),
      'flujos', (select jsonb_build_object(
          'leads', f.leads, 'leads_por_origen', f.leads_por_origen, 'leads_por_anuncio', f.leads_por_anuncio,
          'ventas', f.ventas, 'ventas_ia', f.ventas_ia, 'monto', f.monto, 'ventas_por_etapa', f.ventas_por_etapa,
          'actualizado_at', f.actualizado_at)
          from flujos_diario f where f.workspace_id = ws and f.dia = c.dia),
      'ia_llegaron', (select count(*) from pedidos_pendientes pp
          where pp.workspace_id = ws and public.dia_de_lima(coalesce(pp.creado_en_origen, pp.created_at)) = c.dia),
      'ia_programadas', (select count(*) from pedidos_pendientes pp
          where pp.workspace_id = ws and pp.estado = 'programado'
            and public.dia_de_lima(coalesce(pp.creado_en_origen, pp.created_at)) = c.dia),
      'ia_descartadas', (select count(*) from pedidos_pendientes pp
          where pp.workspace_id = ws and pp.estado = 'descartado'
            and public.dia_de_lima(coalesce(pp.creado_en_origen, pp.created_at)) = c.dia)
    ) order by c.dia desc), '[]'::jsonb)
    into dias
    from calendario c;

  select jsonb_build_object(
      'pendientes', count(*) filter (where estado in ('VOLVER A LLAMAR', 'COORDINACIÓN')),
      'pendientes_monto', coalesce(sum(monto) filter (where estado in ('VOLVER A LLAMAR', 'COORDINACIÓN')), 0),
      'pendientes_mas_de_7_dias', count(*) filter (where estado in ('VOLVER A LLAMAR', 'COORDINACIÓN')
                                                     and fecha_creacion < now() - interval '7 days'),
      'caidos', count(*) filter (where estado = 'CONFIRMADO'
                                   and coalesce(fecha_estado, fecha_creacion) < limite
                                   and coalesce(ultima_gestion, fecha_creacion) < limite),
      'caidos_monto', coalesce(sum(monto) filter (where estado = 'CONFIRMADO'
                                   and coalesce(fecha_estado, fecha_creacion) < limite
                                   and coalesce(ultima_gestion, fecha_creacion) < limite), 0),
      'en_camino', count(*) filter (where estado in ('CONFIRMADO', 'EN TRÁNSITO', 'EN OFICINA')),
      'en_camino_monto', coalesce(sum(monto) filter (where estado in ('CONFIRMADO', 'EN TRÁNSITO', 'EN OFICINA')), 0),
      'ia_sin_programar', (select count(*) from pedidos_pendientes pp where pp.workspace_id = ws and pp.estado = 'pendiente'))
    into hoy
    from pedidos
   where workspace_id = ws and not coalesce(es_prueba, false);

  -- Cómo están hoy los pedidos que se registraron en el rango.
  select coalesce(jsonb_object_agg(x.estado, jsonb_build_object('n', x.n, 'monto', x.monto)), '{}'::jsonb)
    into estados
    from (select estado, count(*) as n, coalesce(sum(monto), 0) as monto
            from pedidos
           where workspace_id = ws and not coalesce(es_prueba, false)
             and public.dia_de_lima(fecha_creacion) between desde and hasta
           group by estado) x;

  return jsonb_build_object('dias', dias, 'hoy', hoy, 'estados_del_rango', estados);
end;
$$;

grant execute on function public.dia_de_lima(timestamptz) to authenticated, service_role;
grant execute on function public.estado_inicial(uuid, text) to authenticated, service_role;
grant execute on function public.analitica_asesoras(uuid, date, date, integer) to authenticated;
grant execute on function public.analitica_empresa(uuid, date, date, integer) to authenticated;
