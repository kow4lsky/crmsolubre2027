-- Productos editables desde el CRM (Configuración → Productos), y la
-- corrección de CHISGUETE → CHISGETE.
--
-- Cambiar el nombre de un producto no es sólo cambiarlo en la lista: los
-- pedidos guardan el nombre en sus productos (pedido_items) y en el resumen
-- ("3xSOLUBRE, 1xCHISGUETE"). Esta función cambia los tres juntos.

-- Sin revisar permisos: la usan la función de abajo y esta migración.
create or replace function public.aplicar_nuevo_nombre_de_producto(ws uuid, viejo text, nuevo text)
returns void language plpgsql security definer set search_path = public as $$
declare
  patron text := regexp_replace(viejo, '([.*+?^${}()|\[\]\\])', '\\\1', 'g');
begin
  if coalesce(trim(nuevo), '') = '' or viejo = nuevo then
    return;
  end if;

  -- Es una corrección, no una edición de cada pedido: no va al historial.
  perform set_config('crm.importando', 'on', true);

  -- Si un pedido ya tenía los dos nombres, se suman las cantidades.
  update pedido_items n
     set cantidad = n.cantidad + v.cantidad
    from pedido_items v
   where v.workspace_id = ws and v.producto = viejo
     and n.pedido_id = v.pedido_id and n.producto = nuevo;
  delete from pedido_items v
   where v.workspace_id = ws and v.producto = viejo
     and exists (select 1 from pedido_items n where n.pedido_id = v.pedido_id and n.producto = nuevo);
  update pedido_items set producto = nuevo where workspace_id = ws and producto = viejo;

  -- El resumen: "1xCHISGUETE" → "1xCHISGETE" (sin tocar otras palabras).
  update pedidos
     set pedido = regexp_replace(pedido, '(\d+\s*[xX]\s*)' || patron || '(?![[:alnum:]])', '\1' || nuevo, 'gi')
   where workspace_id = ws and pedido ~* ('\d+\s*[xX]\s*' || patron || '(?![[:alnum:]])');

  -- Si el nombre nuevo ya estaba en la lista, el viejo se quita: quedan juntos.
  if exists (select 1 from productos where workspace_id = ws and nombre = nuevo) then
    delete from productos where workspace_id = ws and nombre = viejo;
  else
    update productos set nombre = nuevo where workspace_id = ws and nombre = viejo;
  end if;

  perform set_config('crm.importando', 'off', true);
end;
$$;

-- El administrador cambia el nombre de un producto desde el CRM.
create or replace function public.renombrar_producto(ws uuid, producto uuid, nuevo text)
returns void language plpgsql security definer set search_path = public as $$
declare
  limpio text := upper(regexp_replace(trim(coalesce(nuevo, '')), '\s+', ' ', 'g'));
  viejo text;
begin
  if public.rol_de_venta(ws) is distinct from 'admin' then
    raise exception 'Solo el administrador puede cambiar los productos.';
  end if;
  if limpio = '' then
    raise exception 'El nombre no puede quedar vacío.';
  end if;
  select nombre into viejo from productos where id = producto and workspace_id = ws;
  if viejo is null then
    raise exception 'Ese producto ya no existe.';
  end if;
  if viejo = limpio then
    return;
  end if;
  if exists (select 1 from productos where workspace_id = ws and nombre = limpio) then
    raise exception 'Ya hay un producto llamado %.', limpio;
  end if;
  perform public.aplicar_nuevo_nombre_de_producto(ws, viejo, limpio);
end;
$$;

revoke all on function public.aplicar_nuevo_nombre_de_producto(uuid, text, text) from public, anon, authenticated;
grant execute on function public.renombrar_producto(uuid, uuid, text) to authenticated;

-- La corrección pedida: CHISGUETE se escribe CHISGETE.
do $$
declare
  w record;
begin
  for w in select distinct workspace_id from public.productos where nombre = 'CHISGUETE' loop
    perform public.aplicar_nuevo_nombre_de_producto(w.workspace_id, 'CHISGUETE', 'CHISGETE');
  end loop;
end $$;
