-- Los indicadores de arriba de la base de pedidos. Cada asesora ve los suyos;
-- el administrador y el encargado, los de todo el equipo. Devuelve los
-- números y los pedidos que cuenta cada uno (para abrirlos al hacer clic).

create or replace function public.indicadores_de_pedidos(ws uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  rol text := public.rol_de_venta(ws);
  general boolean;
  hoy date := (now() at time zone 'America/Lima')::date;
  resultado jsonb;
begin
  if rol is null then
    raise exception 'No eres parte de este equipo.';
  end if;
  general := rol in ('admin', 'encargado');

  with mios as (
    select p.*
    from public.pedidos p
    where p.workspace_id = ws
      and not coalesce(p.es_prueba, false)
      and (general or public.es_pedido_mio(p))
  ),
  -- Lo que gestionó hoy (una persona, no Swayp ni Shalom): crear, programar, cambiar.
  movidas as (
    select h.pedido_id, h.accion, h.detalle
    from public.pedido_historial h
    join mios m on m.id = h.pedido_id
    where h.workspace_id = ws
      and public.dia_de_lima(h.created_at) = hoy
      and h.usuario_id is not null
      and (general or h.usuario_id = auth.uid())
  ),
  creados as (select distinct pedido_id from movidas where accion = 'CREADO'),
  programados as (
    select distinct pedido_id from movidas
    where (accion = 'CREADO' and detalle like '%Estado inicial: CONFIRMADO%')
       or (accion = 'ESTADO' and detalle ~ '→ CONFIRMADO(;|$)')
  ),
  modificados as (
    select distinct pedido_id from movidas
    where accion in ('ESTADO', 'EDICIÓN') and pedido_id not in (select pedido_id from creados)
  ),
  gestionados as (select distinct pedido_id from movidas),
  entregados as (
    select id from mios
    where estado = 'ENTREGADO' and coalesce(tipo_pedido, 'VENTA') = 'VENTA'
      and public.dia_de_lima(fecha_entregado) = hoy
  ),
  confirmados as (
    select id, public.dia_de_lima(coalesce(fecha_estado, fecha_creacion, created_at)) < hoy as atrasado
    from mios where estado = 'CONFIRMADO'
  ),
  transito as (select id from mios where destino ilike 'provincia' and estado = 'EN TRÁNSITO'),
  destino as (select id from mios where destino ilike 'provincia' and estado = 'EN OFICINA')
  select jsonb_build_object(
    'general', general,
    'gestionados', jsonb_build_object(
      'ids', coalesce((select jsonb_agg(pedido_id) from gestionados), '[]'),
      'creados', coalesce((select jsonb_agg(pedido_id) from creados), '[]'),
      'programados', coalesce((select jsonb_agg(pedido_id) from programados), '[]'),
      'modificados', coalesce((select jsonb_agg(pedido_id) from modificados), '[]')
    ),
    'entregados', coalesce((select jsonb_agg(id) from entregados), '[]'),
    'confirmados', jsonb_build_object(
      'ids', coalesce((select jsonb_agg(id) from confirmados), '[]'),
      'atrasados', coalesce((select jsonb_agg(id) from confirmados where atrasado), '[]')
    ),
    'provincia', jsonb_build_object(
      'transito', coalesce((select jsonb_agg(id) from transito), '[]'),
      'destino', coalesce((select jsonb_agg(id) from destino), '[]')
    )
  ) into resultado;

  return resultado;
end;
$$;
