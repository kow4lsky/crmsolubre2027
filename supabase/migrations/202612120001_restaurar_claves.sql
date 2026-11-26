-- Arreglo de una sola vez: "Actualizar Shalom" le puso por error la clave
-- configurada (1127) a pedidos antiguos que encontró por DNI. Cada cambio
-- quedó en el historial ("CLAVE: 1126 → 1127"): de ahí se devuelve la clave
-- que tenía cada uno. No toca los pedidos de hoy en adelante ni los que se
-- registraron en Shalom con esa clave (esos cambiaron también el tracking).

with cambios as (
  select distinct on (h.pedido_id)
    h.pedido_id,
    nullif(nullif(trim(substring(h.detalle from 'CLAVE: ([^;]*) → 1127')), '—'), '') as anterior
  from public.pedido_historial h
  join public.pedidos p on p.id = h.pedido_id
  where h.usuario_id is null
    and h.detalle like '%CLAVE: % → 1127%'
    and h.detalle not like '%TRACKING:%'
    and p.clave = '1127'
    and p.fecha_registro < date '2026-11-26'
  order by h.pedido_id, h.created_at
),
restaurados as (
  update public.pedidos p
  set clave = c.anterior
  from cambios c
  where p.id = c.pedido_id
  returning p.codigo, p.clave
)
select count(*) as pedidos_con_su_clave_de_vuelta from restaurados;
