-- Los pedidos se ordenan por el número del código: el último creado, arriba.
--
-- `codigo` es texto y ordenado como texto "WED999" queda arriba de "WED7653".
-- `codigo_num` es el número del final (WED7653 → 7653), calculado solo. Los
-- códigos que no siguen la forma LETRAS + NÚMERO (por ejemplo WED7649-2) no
-- tienen número y van al final.
--
-- El próximo código también sale de acá: el más alto + 1. Antes se calculaba
-- con el texto, y un código raro con muchos dígitos podía romper el cálculo.

alter table public.pedidos
  add column if not exists codigo_num integer generated always as (
    case when codigo ~ '^[A-Za-z]*[0-9]{1,9}$'
      then (substring(codigo from '([0-9]+)$'))::integer
    end
  ) stored;

create index if not exists pedidos_codigo_num_idx
  on public.pedidos (workspace_id, codigo_num desc nulls last);

create or replace function public.siguiente_codigo(ws uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  numero integer;
  pre text;
begin
  insert into public.pedido_contadores (workspace_id, ultimo)
  values (
    ws,
    greatest(1000, coalesce((
      select max(codigo_num) from public.pedidos where workspace_id = ws
    ), 1000)) + 1
  )
  on conflict (workspace_id) do update set ultimo = public.pedido_contadores.ultimo + 1
  returning ultimo, prefijo into numero, pre;
  return pre || numero;
end;
$$;

create or replace function public.importar_pedidos(ws uuid, filas jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare
  cuantos integer;
begin
  if public.rol_de_venta(ws) is distinct from 'admin' then
    raise exception 'Solo un administrador puede importar pedidos.';
  end if;

  perform set_config('crm.importando', 'on', true);

  insert into public.pedidos (
    workspace_id, codigo, fecha_creacion, fecha_registro, monto, pedido, cliente, direccion, dni,
    provincia, distrito, celular, destino, estado, asesor, canal, envio, courier, costo_envio,
    inventario, tracking, clave, nota, adelanto, pago_completo, prox_llamada, tipo_cliente,
    tipo_venta, cerrado_por, comision, creado_por, asignado_a, encargado, fecha_asig_encargado,
    fecha_primera_gestion, fecha_estado, fecha_confirmado, fecha_salida, fecha_entregado,
    ultima_gestion, estado_etiqueta, fecha_etiqueta, estado_shalom, es_prueba, extra
  )
  select
    ws, f.codigo, coalesce(f.fecha_creacion, now()), coalesce(f.fecha_registro, current_date),
    coalesce(f.monto, 0), coalesce(f.pedido, ''), coalesce(f.cliente, ''), f.direccion, f.dni,
    f.provincia, f.distrito, f.celular, f.destino, coalesce(f.estado, 'VOLVER A LLAMAR'), f.asesor,
    f.canal, f.envio, f.courier, f.costo_envio, f.inventario, f.tracking, f.clave, f.nota,
    f.adelanto, f.pago_completo, f.prox_llamada, f.tipo_cliente, f.tipo_venta, f.cerrado_por,
    f.comision, f.creado_por, f.asignado_a, f.encargado, f.fecha_asig_encargado,
    f.fecha_primera_gestion, f.fecha_estado, f.fecha_confirmado, f.fecha_salida,
    f.fecha_entregado, f.ultima_gestion, f.estado_etiqueta, f.fecha_etiqueta, f.estado_shalom,
    coalesce(f.es_prueba, false), coalesce(f.extra, '{}'::jsonb)
  from jsonb_populate_recordset(null::public.pedidos, filas) f
  where coalesce(trim(f.codigo), '') <> ''
  on conflict (workspace_id, codigo) do update set
    fecha_creacion = excluded.fecha_creacion, fecha_registro = excluded.fecha_registro,
    monto = excluded.monto, pedido = excluded.pedido, cliente = excluded.cliente,
    direccion = excluded.direccion, dni = excluded.dni, provincia = excluded.provincia,
    distrito = excluded.distrito, celular = excluded.celular, destino = excluded.destino,
    estado = excluded.estado, asesor = excluded.asesor, canal = excluded.canal,
    envio = excluded.envio, courier = excluded.courier, costo_envio = excluded.costo_envio,
    inventario = excluded.inventario, tracking = excluded.tracking, clave = excluded.clave,
    nota = excluded.nota, adelanto = excluded.adelanto, pago_completo = excluded.pago_completo,
    prox_llamada = excluded.prox_llamada, tipo_cliente = excluded.tipo_cliente,
    tipo_venta = excluded.tipo_venta, cerrado_por = excluded.cerrado_por,
    comision = excluded.comision, creado_por = excluded.creado_por,
    asignado_a = excluded.asignado_a, encargado = excluded.encargado,
    fecha_asig_encargado = excluded.fecha_asig_encargado,
    fecha_primera_gestion = excluded.fecha_primera_gestion, fecha_estado = excluded.fecha_estado,
    fecha_confirmado = excluded.fecha_confirmado, fecha_salida = excluded.fecha_salida,
    fecha_entregado = excluded.fecha_entregado, ultima_gestion = excluded.ultima_gestion,
    estado_etiqueta = excluded.estado_etiqueta, fecha_etiqueta = excluded.fecha_etiqueta,
    estado_shalom = excluded.estado_shalom, es_prueba = excluded.es_prueba, extra = excluded.extra;

  get diagnostics cuantos = row_count;

  -- Los productos: se reemplazan enteros con lo que dice la planilla.
  delete from public.pedido_items i
  using public.pedidos p
  where i.pedido_id = p.id and p.workspace_id = ws
    and p.codigo in (select x ->> 'codigo' from jsonb_array_elements(filas) x);

  insert into public.pedido_items (pedido_id, workspace_id, producto, cantidad)
  select p.id, ws, upper(trim(item.key)), sum((item.value)::numeric)
  from jsonb_array_elements(filas) x
  join public.pedidos p on p.workspace_id = ws and p.codigo = x ->> 'codigo'
  cross join lateral jsonb_each_text(coalesce(x -> 'items', '{}'::jsonb)) item
  where item.value ~ '^\d+(\.\d+)?$' and (item.value)::numeric > 0
  group by p.id, upper(trim(item.key));

  insert into public.productos (workspace_id, nombre, orden)
  select ws, nombre, 100 from (
    select distinct upper(trim(item.key)) as nombre
    from jsonb_array_elements(filas) x
    cross join lateral jsonb_each_text(coalesce(x -> 'items', '{}'::jsonb)) item
  ) n
  on conflict (workspace_id, nombre) do nothing;

  -- Que el próximo código siga después del más alto importado.
  insert into public.pedido_contadores (workspace_id, ultimo)
  select ws, coalesce(max(codigo_num), 1000)
  from public.pedidos where workspace_id = ws
  on conflict (workspace_id) do update set ultimo = greatest(public.pedido_contadores.ultimo, excluded.ultimo);

  return cuantos;
end;
$$;
