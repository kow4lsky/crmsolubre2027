-- Inventario: dos almacenes (la bodega de Swayp y el almacén propio de
-- Solubre en Lince), un kárdex con cada movimiento y el recorrido de la
-- mercadería de cada pedido (sale → en camino → entregado o por regresar →
-- regresó).
--
-- Cada movimiento mueve unidades entre dos "lugares" de un almacén:
--   bodega: lo que está físicamente en el almacén;
--   camino: lo que ya salió con un pedido y todavía no se entregó ni regresó.
-- El stock del almacén es bodega + camino: se descuenta recién al entregar.

/* ------------------------------------------------------------- almacenes */

create table if not exists public.almacenes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Igual que pedidos.inventario: SWAYP o SOLUBRE.
  codigo text not null,
  nombre text not null,
  -- swayp: lo maneja Swayp, desde el CRM sólo se cuadra con su reporte.
  -- propio: se registran ingresos, ajustes y envíos a mano.
  lo_maneja text not null default 'propio' check (lo_maneja in ('swayp', 'propio')),
  -- Hasta que se carga el stock inicial, los pedidos no lo mueven.
  iniciado_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, codigo)
);

alter table public.almacenes enable row level security;
drop policy if exists "almacenes: ver" on public.almacenes;
create policy "almacenes: ver" on public.almacenes for select to authenticated
  using (public.rol_de_venta(workspace_id) in ('admin', 'encargado'));

insert into public.almacenes (workspace_id, codigo, nombre, lo_maneja)
select w.id, a.codigo, a.nombre, a.lo_maneja
from public.workspaces w
cross join (values ('SWAYP', 'Bodega Swayp (Lima)', 'swayp'), ('SOLUBRE', 'Almacén Solubre (Lince)', 'propio')) as a (codigo, nombre, lo_maneja)
on conflict (workspace_id, codigo) do nothing;

-- El código con el que Swayp conoce cada producto (su "código de barras").
alter table public.productos add column if not exists codigo_swayp text;

/* ---------------------------------------------------------------- kárdex */

create table if not exists public.inventario_movimientos (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  almacen text not null,
  producto_id uuid references public.productos(id) on delete set null,
  -- El nombre en ese momento, por si el producto cambia de nombre o se borra.
  producto text not null,
  tipo text not null check (tipo in ('INICIAL', 'INGRESO', 'AJUSTE', 'CUADRE', 'TRANSFERENCIA', 'SALIDA', 'ENTREGA', 'RETORNO')),
  bodega integer not null default 0,
  camino integer not null default 0,
  -- Sin llave foránea a propósito: el movimiento se anota antes de que el
  -- pedido termine de guardarse, y queda aunque el pedido se borre.
  pedido_id uuid,
  pedido_codigo text,
  nota text,
  usuario_id uuid,
  usuario text,
  created_at timestamptz not null default now()
);

create index if not exists inventario_movimientos_idx on public.inventario_movimientos (workspace_id, almacen, created_at desc);
create index if not exists inventario_movimientos_pedido_idx on public.inventario_movimientos (pedido_id);

alter table public.inventario_movimientos enable row level security;
drop policy if exists "inventario_movimientos: ver" on public.inventario_movimientos;
create policy "inventario_movimientos: ver" on public.inventario_movimientos for select to authenticated
  using (public.rol_de_venta(workspace_id) in ('admin', 'encargado'));
-- Sin políticas de escritura: sólo las funciones de acá abajo escriben.

-- El mínimo de cada producto en cada almacén: por debajo, aparece la alerta.
create table if not exists public.inventario_minimos (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  almacen text not null,
  producto_id uuid not null references public.productos(id) on delete cascade,
  minimo integer not null default 0 check (minimo >= 0),
  primary key (workspace_id, almacen, producto_id)
);

alter table public.inventario_minimos enable row level security;
drop policy if exists "inventario_minimos: ver" on public.inventario_minimos;
create policy "inventario_minimos: ver" on public.inventario_minimos for select to authenticated
  using (public.rol_de_venta(workspace_id) in ('admin', 'encargado'));
drop policy if exists "inventario_minimos: editar" on public.inventario_minimos;
create policy "inventario_minimos: editar" on public.inventario_minimos for all to authenticated
  using (public.rol_de_venta(workspace_id) in ('admin', 'encargado'))
  with check (public.rol_de_venta(workspace_id) in ('admin', 'encargado'));

-- Dónde está la mercadería de cada pedido.
--   null: todavía no salió;  EN CAMINO;  ENTREGADO;  POR REGRESAR;  REGRESÓ;
--   ANTERIOR: ya estaba cerrado cuando se empezó a llevar el inventario.
alter table public.pedidos
  add column if not exists inv_estado text,
  add column if not exists inv_almacen text;

/* ------------------------------------------------------------- funciones */

create or replace function public.inv_quien(ws uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    nullif(public.mi_alias(ws), ''),
    (select email from auth.users where id = auth.uid()),
    'sistema'
  );
$$;

-- Anota un movimiento por cada producto del pedido.
create or replace function public.inv_mover_pedido(p public.pedidos, almacen text, tipo text, por_bodega integer, por_camino integer, nota text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.inventario_movimientos (workspace_id, almacen, producto_id, producto, tipo, bodega, camino, pedido_id, pedido_codigo, nota, usuario_id, usuario)
  select p.workspace_id, almacen, pr.id, i.producto, tipo, por_bodega * i.cantidad, por_camino * i.cantidad, p.id, p.codigo, nota,
         auth.uid(), public.inv_quien(p.workspace_id)
  from public.pedido_items i
  left join public.productos pr on pr.workspace_id = p.workspace_id and upper(pr.nombre) = upper(i.producto)
  where i.pedido_id = p.id and i.cantidad > 0;
end;
$$;
revoke execute on function public.inv_mover_pedido(public.pedidos, text, text, integer, integer, text) from public, anon, authenticated;

-- Con cada cambio de estado, la mercadería del pedido se mueve sola:
--   sale (EN TRÁNSITO, EN OFICINA…): de la bodega pasa a "en camino";
--   ENTREGADO: sale del inventario (recién acá se descuenta);
--   EN DEVOLUCIÓN, RECHAZADO…: queda "por regresar" hasta que se confirme
--   que volvió al almacén (confirmar_retorno).
create or replace function public.pedidos_inventario()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  almacen text;
  st text;
begin
  if current_setting('crm.importando', true) = 'on' then
    return new;
  end if;
  st := new.inv_estado;
  if st in ('ANTERIOR', 'REGRESÓ') then
    return new;
  end if;

  almacen := coalesce(new.inv_almacen, upper(trim(coalesce(new.inventario, ''))));
  if not exists (
    select 1 from public.almacenes a
    where a.workspace_id = new.workspace_id and a.codigo = almacen and a.iniciado_at is not null
  ) then
    return new;
  end if;

  -- Sin productos todavía (el formulario los guarda después del pedido), se
  -- espera: al llegar los productos se vuelve a mirar.
  if st is null and new.estado in ('EN TRÁNSITO', 'EN OFICINA', 'ENTREGADO', 'EN DEVOLUCIÓN')
     and exists (select 1 from public.pedido_items i where i.pedido_id = new.id) then
    perform public.inv_mover_pedido(new, almacen, 'SALIDA', -1, 1, 'Salió del almacén con el pedido');
    st := 'EN CAMINO';
    new.inv_almacen := almacen;
  end if;

  if st in ('EN CAMINO', 'POR REGRESAR') and new.estado = 'ENTREGADO' then
    perform public.inv_mover_pedido(new, almacen, 'ENTREGA', 0, -1, 'Entregado al cliente');
    st := 'ENTREGADO';
  elsif st = 'EN CAMINO' and new.estado in ('EN DEVOLUCIÓN', 'RECHAZADO', 'DEPURADO', 'NC') then
    st := 'POR REGRESAR';
  elsif st = 'POR REGRESAR' and new.estado in ('EN TRÁNSITO', 'EN OFICINA') then
    st := 'EN CAMINO';
  end if;

  new.inv_estado := st;
  return new;
end;
$$;

drop trigger if exists pedidos_inventario on public.pedidos;
create trigger pedidos_inventario
  before insert or update on public.pedidos
  for each row execute function public.pedidos_inventario();

-- Si los productos llegan cuando el pedido ya salió, recién ahí se mueve.
create or replace function public.pedido_items_inventario()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_setting('crm.importando', true) = 'on' then
    return null;
  end if;
  update public.pedidos set inv_estado = inv_estado
  where id = new.pedido_id and inv_estado is null
    and estado in ('EN TRÁNSITO', 'EN OFICINA', 'ENTREGADO', 'EN DEVOLUCIÓN');
  return null;
end;
$$;

drop trigger if exists pedido_items_inventario on public.pedido_items;
create trigger pedido_items_inventario
  after insert on public.pedido_items
  for each row execute function public.pedido_items_inventario();

-- La mercadería de un pedido devuelto llegó al almacén. La llama el
-- administrador o el encargado ("Llegó al almacén"), o el servidor cuando
-- Swayp confirma la devolución en su bodega.
create or replace function public.confirmar_retorno(ws uuid, pedido uuid, nota text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  fila public.pedidos;
begin
  if auth.uid() is not null and public.rol_de_venta(ws) not in ('admin', 'encargado') then
    raise exception 'Solo el administrador o el encargado pueden confirmar una devolución.';
  end if;
  select * into fila from public.pedidos where id = confirmar_retorno.pedido and workspace_id = ws;
  if fila.id is null then
    raise exception 'No se encontró el pedido.';
  end if;
  if fila.inv_estado not in ('POR REGRESAR', 'EN CAMINO') then
    return;
  end if;
  perform public.inv_mover_pedido(fila, fila.inv_almacen, 'RETORNO', 1, -1, coalesce(nullif(trim(nota), ''), 'Regresó al almacén'));
  update public.pedidos set inv_estado = 'REGRESÓ' where id = fila.id;
end;
$$;

-- Ingreso, ajuste o envío de Solubre a Swayp. Sólo en el almacén propio: el de
-- Swayp lo maneja Swayp y se corrige con el cuadre.
create or replace function public.registrar_movimiento(ws uuid, almacen text, producto uuid, tipo text, cantidad integer, nota text default null, destino text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  alm public.almacenes;
  prod public.productos;
begin
  if public.rol_de_venta(ws) not in ('admin', 'encargado') then
    raise exception 'Solo el administrador o el encargado pueden mover el inventario.';
  end if;
  select * into alm from public.almacenes where workspace_id = ws and codigo = almacen;
  if alm.id is null then raise exception 'No existe el almacén %.', almacen; end if;
  if alm.lo_maneja <> 'propio' then
    raise exception 'El inventario de % lo maneja Swayp: se corrige subiendo su reporte en "Cuadre con Swayp".', alm.nombre;
  end if;
  if alm.iniciado_at is null then raise exception 'Primero carga el stock inicial de %.', alm.nombre; end if;
  select * into prod from public.productos where id = producto and workspace_id = ws;
  if prod.id is null then raise exception 'No se encontró el producto.'; end if;
  if coalesce(cantidad, 0) = 0 then raise exception 'La cantidad no puede ser cero.'; end if;

  if tipo = 'INGRESO' then
    if cantidad < 0 then raise exception 'Un ingreso suma: escribe la cantidad sin signo.'; end if;
    insert into public.inventario_movimientos (workspace_id, almacen, producto_id, producto, tipo, bodega, nota, usuario_id, usuario)
    values (ws, almacen, prod.id, prod.nombre, 'INGRESO', cantidad, nullif(trim(nota), ''), auth.uid(), public.inv_quien(ws));
  elsif tipo = 'AJUSTE' then
    if nullif(trim(nota), '') is null then raise exception 'Cuenta el motivo del ajuste (por ejemplo: conteo, producto dañado).'; end if;
    insert into public.inventario_movimientos (workspace_id, almacen, producto_id, producto, tipo, bodega, nota, usuario_id, usuario)
    values (ws, almacen, prod.id, prod.nombre, 'AJUSTE', cantidad, trim(nota), auth.uid(), public.inv_quien(ws));
  elsif tipo = 'TRANSFERENCIA' then
    if cantidad < 0 then raise exception 'Escribe la cantidad que envías, sin signo.'; end if;
    if not exists (select 1 from public.almacenes where workspace_id = ws and codigo = destino and codigo <> almacen) then
      raise exception 'Elige a qué almacén lo envías.';
    end if;
    insert into public.inventario_movimientos (workspace_id, almacen, producto_id, producto, tipo, bodega, nota, usuario_id, usuario)
    values
      (ws, almacen, prod.id, prod.nombre, 'TRANSFERENCIA', -cantidad, coalesce(nullif(trim(nota), ''), 'Enviado a ' || destino), auth.uid(), public.inv_quien(ws)),
      (ws, destino, prod.id, prod.nombre, 'TRANSFERENCIA', cantidad, coalesce(nullif(trim(nota), ''), 'Llegó de ' || almacen), auth.uid(), public.inv_quien(ws));
  else
    raise exception 'Tipo de movimiento no válido.';
  end if;
end;
$$;

-- Deja la bodega de un almacén como dice un conteo (o el reporte de Swayp).
-- `filas`: [{"producto_id": "...", "bodega": 120}, ...]. La primera vez es el
-- stock inicial: desde ahí los pedidos mueven el inventario, los que ya
-- estaban en camino o devolviéndose quedan anotados, y los ya cerrados no.
create or replace function public.cuadrar_almacen(ws uuid, almacen text, filas jsonb, nota text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare
  alm public.almacenes;
  inicial boolean;
  fila jsonb;
  prod public.productos;
  actual integer;
  objetivo integer;
  ajustes integer := 0;
  p public.pedidos;
begin
  if public.rol_de_venta(ws) is distinct from 'admin' then
    raise exception 'Solo el administrador puede cuadrar el inventario.';
  end if;
  select * into alm from public.almacenes where workspace_id = ws and codigo = almacen;
  if alm.id is null then raise exception 'No existe el almacén %.', almacen; end if;
  inicial := alm.iniciado_at is null;

  for fila in select * from jsonb_array_elements(filas) loop
    select * into prod from public.productos where id = (fila ->> 'producto_id')::uuid and workspace_id = ws;
    continue when prod.id is null;
    objetivo := greatest(0, coalesce((fila ->> 'bodega')::integer, 0));
    select coalesce(sum(m.bodega), 0) into actual
    from public.inventario_movimientos m
    where m.workspace_id = ws and m.almacen = cuadrar_almacen.almacen and m.producto_id = prod.id;
    if objetivo <> actual then
      insert into public.inventario_movimientos (workspace_id, almacen, producto_id, producto, tipo, bodega, nota, usuario_id, usuario)
      values (ws, almacen, prod.id, prod.nombre, case when inicial then 'INICIAL' else 'CUADRE' end, objetivo - actual,
              coalesce(nullif(trim(nota), ''), case when inicial then 'Stock inicial' else 'Cuadre con el conteo' end),
              auth.uid(), public.inv_quien(ws));
      ajustes := ajustes + 1;
    end if;
  end loop;

  if inicial then
    update public.almacenes set iniciado_at = now() where id = alm.id;
    perform set_config('crm.importando', 'on', true);
    for p in
      select * from public.pedidos
      where workspace_id = ws and upper(trim(coalesce(inventario, ''))) = almacen and inv_estado is null
    loop
      if p.estado in ('EN TRÁNSITO', 'EN OFICINA', 'EN DEVOLUCIÓN') then
        perform public.inv_mover_pedido(p, almacen, 'SALIDA', 0, 1, 'Ya estaba fuera del almacén al empezar el inventario');
        update public.pedidos
        set inv_estado = case when p.estado = 'EN DEVOLUCIÓN' then 'POR REGRESAR' else 'EN CAMINO' end, inv_almacen = almacen
        where id = p.id;
      elsif p.estado in ('ENTREGADO', 'RECHAZADO', 'NC', 'DEPURADO') then
        update public.pedidos set inv_estado = 'ANTERIOR', inv_almacen = almacen where id = p.id;
      end if;
    end loop;
    perform set_config('crm.importando', 'off', true);
  end if;
  return ajustes;
end;
$$;

/* ------------------------------------------------------------- consultas */

-- El stock de cada producto en cada almacén.
create or replace function public.stock_de_inventario(ws uuid)
returns table (almacen text, producto_id uuid, producto text, codigo_swayp text, activo boolean, bodega integer, camino integer, minimo integer, por_dia numeric)
language sql stable security definer set search_path = public as $$
  with permitido as (select public.rol_de_venta(ws) in ('admin', 'encargado') as ok),
  saldos as (
    select m.almacen, m.producto_id, sum(m.bodega)::integer as bodega, sum(m.camino)::integer as camino
    from public.inventario_movimientos m
    where m.workspace_id = ws and m.producto_id is not null
    group by m.almacen, m.producto_id
  ),
  -- Lo entregado por día en los últimos 7 días, para estimar cuánto dura.
  ritmo as (
    select m.almacen, m.producto_id, round(-sum(m.camino)::numeric / 7, 1) as por_dia
    from public.inventario_movimientos m
    where m.workspace_id = ws and m.tipo = 'ENTREGA' and m.created_at >= now() - interval '7 days'
    group by m.almacen, m.producto_id
  )
  select a.codigo, pr.id, pr.nombre, pr.codigo_swayp, pr.activo,
         coalesce(s.bodega, 0), coalesce(s.camino, 0), coalesce(mi.minimo, 0), coalesce(r.por_dia, 0)
  from public.almacenes a
  cross join public.productos pr
  left join saldos s on s.almacen = a.codigo and s.producto_id = pr.id
  left join public.inventario_minimos mi on mi.workspace_id = ws and mi.almacen = a.codigo and mi.producto_id = pr.id
  left join ritmo r on r.almacen = a.codigo and r.producto_id = pr.id
  where a.workspace_id = ws and pr.workspace_id = ws and (select ok from permitido)
    and (pr.activo or s.bodega <> 0 or s.camino <> 0)
  order by a.codigo, pr.orden, pr.nombre;
$$;

-- Los productos que quedan en o por debajo de su mínimo (para la alerta al entrar).
create or replace function public.alertas_de_stock(ws uuid)
returns table (almacen text, producto text, bodega integer, minimo integer, por_dia numeric)
language sql stable security definer set search_path = public as $$
  select s.almacen, s.producto, s.bodega, s.minimo, s.por_dia
  from public.stock_de_inventario(ws) s
  join public.almacenes a on a.workspace_id = ws and a.codigo = s.almacen and a.iniciado_at is not null
  where s.minimo > 0 and s.bodega <= s.minimo
  order by s.bodega::numeric / nullif(s.minimo, 0), s.producto;
$$;
