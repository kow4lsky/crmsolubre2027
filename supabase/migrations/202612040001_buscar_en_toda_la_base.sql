-- Buscar en toda la base: una asesora ve en su tabla sólo sus pedidos, pero
-- a veces necesita encontrar el de otra (el cliente llama, recompra, etc.).
--
-- Estas funciones le devuelven los pedidos de OTRAS personas que coinciden
-- con lo que busca (código, cliente, DNI, celular, tracking o producto), y su
-- historial. Son sólo para ver: no cambian la regla de quién edita qué, que
-- sigue en las políticas de `pedidos`.

-- Lo mismo que la política "pedidos: ver": si el pedido ya es de quien busca.
create or replace function public.es_pedido_mio(p public.pedidos)
returns boolean language sql stable security definer set search_path = public as $$
  -- coalesce: un importado no tiene creado_por_id, y un null aquí lo escondería.
  select coalesce(public.rol_de_venta(p.workspace_id) = 'admin', false)
    or coalesce(p.creado_por_id = auth.uid(), false)
    or (
      public.mi_alias(p.workspace_id) <> ''
      and public.mi_alias(p.workspace_id) in (
        upper(coalesce(p.creado_por, '')), upper(coalesce(p.asignado_a, '')),
        upper(coalesce(p.asesor, '')), upper(coalesce(p.encargado, ''))
      )
    )
    or (
      public.rol_de_venta(p.workspace_id) = 'encargado'
      and p.estado = 'CONFIRMADO' and coalesce(p.encargado, '') = '' and not coalesce(p.es_prueba, false)
    )
$$;

create or replace function public.buscar_pedidos_de_otros(ws uuid, termino text)
returns setof public.pedidos language plpgsql stable security definer set search_path = public as $$
declare
  limpio text := lower(trim(regexp_replace(coalesce(termino, ''), '[%_\\]', ' ', 'g')));
begin
  if public.rol_de_venta(ws) is null then
    raise exception 'No eres parte de este equipo.';
  end if;
  -- Con menos de 3 letras saldría media base.
  if length(limpio) < 3 then
    return;
  end if;
  return query
    select p.*
      from pedidos p
     where p.workspace_id = ws
       and p.busqueda like '%' || limpio || '%'
       and not public.es_pedido_mio(p)
     order by p.codigo_num desc nulls last
     limit 30;
end;
$$;

-- El historial de un pedido ajeno, para verlo junto con la ficha.
create or replace function public.historial_de_pedido(ws uuid, pedido uuid)
returns setof public.pedido_historial language plpgsql stable security definer set search_path = public as $$
begin
  if public.rol_de_venta(ws) is null then
    raise exception 'No eres parte de este equipo.';
  end if;
  return query
    select h.*
      from pedido_historial h
     where h.workspace_id = ws and h.pedido_id = pedido
     order by h.created_at desc
     limit 100;
end;
$$;

grant execute on function public.es_pedido_mio(public.pedidos) to authenticated;
grant execute on function public.buscar_pedidos_de_otros(uuid, text) to authenticated;
grant execute on function public.historial_de_pedido(uuid, uuid) to authenticated;
