-- Pedidos: el corazón del CRM de ventas contra entrega.
--
-- Trae lo que antes vivía en la pestaña "base" del Google Sheet:
--   * pedidos         — un renglón por pedido, con los datos del cliente.
--   * productos       — el catálogo (SOLUBRE, BROCHAS, ...), editable.
--   * pedido_items    — cuánto de cada producto lleva un pedido. Reemplaza a la
--                       columna por producto: sumar un producto no agrega columnas.
--   * pedido_historial— quién cambió qué y cuándo. Lo llena un trigger, así no
--                       depende de que la pantalla se acuerde de anotarlo.
--   * autorizaciones  — el asesor pide un cambio de estado y el admin lo aprueba.
--
-- Y los roles de venta: admin, encargado, asesor y asesor_temp. Viven en
-- `workspace_members.rol_venta`; el `alias` es el nombre con el que el equipo
-- figura en los pedidos (MILTON, NATHALY, ...).

/* ------------------------------------------------------------ roles de venta */

alter table public.workspace_members
  add column if not exists rol_venta text not null default 'asesor',
  add column if not exists alias text;

alter table public.workspace_members drop constraint if exists workspace_members_rol_venta_check;
alter table public.workspace_members
  add constraint workspace_members_rol_venta_check
  check (rol_venta in ('admin', 'encargado', 'asesor', 'asesor_temp'));

-- Quien ya era administrador sigue siéndolo.
update public.workspace_members set rol_venta = 'admin' where role in ('owner', 'admin');

-- El rol de venta de quien está conectado. owner y admin son siempre 'admin'.
create or replace function public.rol_de_venta(ws uuid)
returns text language sql stable security definer set search_path = public as $$
  select case when m.role in ('owner', 'admin') then 'admin' else m.rol_venta end
  from public.workspace_members m
  where m.workspace_id = ws and m.user_id = auth.uid();
$$;

-- El alias de quien está conectado, en mayúsculas. Vacío si no tiene.
create or replace function public.mi_alias(ws uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(upper(trim(m.alias)), '')
  from public.workspace_members m
  where m.workspace_id = ws and m.user_id = auth.uid();
$$;

-- El admin cambia el rol y el alias de alguien del equipo.
create or replace function public.guardar_miembro_de_venta(ws uuid, usuario uuid, nuevo_rol text, nuevo_alias text)
returns void language plpgsql security definer set search_path = public as $$
declare
  actual text;
begin
  if public.rol_de_venta(ws) is distinct from 'admin' then
    raise exception 'Solo un administrador puede cambiar los roles.';
  end if;
  if nuevo_rol not in ('admin', 'encargado', 'asesor', 'asesor_temp') then
    raise exception 'Rol desconocido: %', nuevo_rol;
  end if;

  select role into actual from public.workspace_members where workspace_id = ws and user_id = usuario;
  if actual is null then
    raise exception 'Esa persona no es parte del equipo.';
  end if;
  if actual = 'owner' and nuevo_rol <> 'admin' then
    raise exception 'La cuenta principal siempre es administradora.';
  end if;

  update public.workspace_members
  set rol_venta = nuevo_rol,
      alias = nullif(upper(trim(nuevo_alias)), ''),
      role = case
        when actual = 'owner' then 'owner'
        when nuevo_rol = 'admin' then 'admin'
        else 'agent'
      end
  where workspace_id = ws and user_id = usuario;
end;
$$;

/* --------------------------------------------------------------- catálogos */

create table if not exists public.productos (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  nombre text not null,
  orden integer not null default 0,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  unique (workspace_id, nombre)
);

-- Prefijo y último número de los códigos (WED7649).
create table if not exists public.pedido_contadores (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  prefijo text not null default 'WED',
  ultimo integer not null default 1000
);

/* ----------------------------------------------------------------- pedidos */

create extension if not exists pg_trgm with schema extensions;

create table if not exists public.pedidos (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  codigo text not null,
  fecha_creacion timestamptz not null default now(),
  fecha_registro date not null default current_date,
  monto numeric(12, 2) not null default 0,
  pedido text not null default '',
  cliente text not null default '',
  direccion text,
  dni text,
  provincia text,
  distrito text,
  celular text,
  destino text,
  estado text not null default 'VOLVER A LLAMAR',
  asesor text,
  canal text,
  envio text,
  courier text,
  costo_envio numeric(12, 2),
  inventario text,
  tracking text,
  clave text,
  nota text,
  adelanto numeric(12, 2),
  pago_completo text,
  prox_llamada date,
  tipo_cliente text,
  tipo_venta text,
  cerrado_por text,
  comision numeric(12, 2),
  creado_por text,
  creado_por_id uuid references auth.users(id) on delete set null,
  asignado_a text,
  encargado text,
  fecha_asig_encargado timestamptz,
  fecha_primera_gestion timestamptz,
  fecha_estado timestamptz,
  fecha_confirmado timestamptz,
  fecha_salida timestamptz,
  fecha_entregado timestamptz,
  ultima_gestion timestamptz,
  estado_etiqueta text,
  fecha_etiqueta timestamptz,
  estado_shalom text,
  -- Los de un asesor temporal: no cuentan en indicadores.
  es_prueba boolean not null default false,
  -- Las columnas de la planilla que no tienen lugar propio (seguimiento de
  -- Shalom, revisiones, etc.). Nada de lo importado se pierde.
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Todo lo que se busca con la caja de búsqueda, junto y en minúsculas.
  busqueda text generated always as (
    lower(
      codigo || ' ' || cliente || ' ' || coalesce(dni, '') || ' ' ||
      coalesce(celular, '') || ' ' || coalesce(tracking, '') || ' ' || pedido
    )
  ) stored,
  unique (workspace_id, codigo),
  constraint pedidos_estado_valido check (estado in (
    'VOLVER A LLAMAR', 'COORDINACIÓN', 'CONFIRMADO', 'EN TRÁNSITO', 'EN OFICINA',
    'ENTREGADO', 'RECHAZADO', 'NC', 'EN DEVOLUCIÓN', 'DEPURADO'
  ))
);

create index if not exists pedidos_registro_idx on public.pedidos (workspace_id, fecha_registro desc, codigo desc);
create index if not exists pedidos_estado_idx on public.pedidos (workspace_id, estado);
create index if not exists pedidos_celular_idx on public.pedidos (workspace_id, celular);
create index if not exists pedidos_dni_idx on public.pedidos (workspace_id, dni);
create index if not exists pedidos_busqueda_idx on public.pedidos using gin (busqueda extensions.gin_trgm_ops);

create table if not exists public.pedido_items (
  pedido_id uuid not null references public.pedidos(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  producto text not null,
  cantidad numeric(10, 2) not null check (cantidad > 0),
  primary key (pedido_id, producto)
);

create table if not exists public.pedido_historial (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references public.pedidos(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  usuario_id uuid references auth.users(id) on delete set null,
  usuario text,
  accion text not null,
  detalle text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists pedido_historial_pedido_idx on public.pedido_historial (pedido_id, created_at desc);

create table if not exists public.autorizaciones (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  pedido_id uuid not null references public.pedidos(id) on delete cascade,
  solicitante_id uuid references auth.users(id) on delete set null,
  solicitante text,
  estado_actual text not null,
  estado_solicitado text not null,
  motivo text not null,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'aprobada', 'rechazada')),
  resuelto_por text,
  resuelto_at timestamptz,
  nota_resolucion text,
  created_at timestamptz not null default now()
);
create index if not exists autorizaciones_pendientes_idx on public.autorizaciones (workspace_id, estado, created_at desc);

/* ------------------------------------------------------------------ reglas */

-- Los estados que un asesor puede mover sin pedir permiso. Si cambia la
-- regla, se cambia acá y en `ESTADOS_LIBRES` de src/lib/pedidos.ts.
create or replace function public.estado_libre(estado text)
returns boolean language sql immutable as $$
  select estado in ('VOLVER A LLAMAR', 'COORDINACIÓN', 'CONFIRMADO', 'NC', 'RECHAZADO');
$$;

-- El próximo código libre. Cuenta desde el más alto que ya exista.
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
      select max((substring(codigo from '(\d+)$'))::integer)
      from public.pedidos where workspace_id = ws and codigo ~ '\d+$'
    ), 1000)) + 1
  )
  on conflict (workspace_id) do update set ultimo = public.pedido_contadores.ultimo + 1
  returning ultimo, prefijo into numero, pre;
  return pre || numero;
end;
$$;

create or replace function public.pedidos_antes_de_guardar()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  rol text;
  yo text;
  hoy integer;
begin
  new.updated_at := now();

  -- La importación trae los datos tal cual estaban en la planilla.
  if current_setting('crm.importando', true) = 'on' then
    return new;
  end if;

  if tg_op = 'INSERT' and coalesce(trim(new.codigo), '') = '' then
    new.codigo := public.siguiente_codigo(new.workspace_id);
  end if;

  if tg_op = 'INSERT' or new.estado is distinct from old.estado then
    new.fecha_estado := now();
    if new.estado = 'CONFIRMADO' and new.fecha_confirmado is null then new.fecha_confirmado := now(); end if;
    if new.estado = 'ENTREGADO' and new.fecha_entregado is null then new.fecha_entregado := now(); end if;
  end if;
  if tg_op = 'UPDATE' then
    new.ultima_gestion := now();
    if old.fecha_primera_gestion is null then new.fecha_primera_gestion := now(); end if;
  end if;

  -- Sin sesión (trabajos del servidor con la service role): no hay rol que mirar.
  if auth.uid() is null then
    return new;
  end if;

  rol := public.rol_de_venta(new.workspace_id);
  yo := public.mi_alias(new.workspace_id);
  if rol is null then
    raise exception 'No sos parte de este equipo.';
  end if;
  if rol = 'admin' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.creado_por_id := auth.uid();
    new.creado_por := nullif(yo, '');
    if coalesce(new.asesor, '') = '' and rol in ('asesor', 'asesor_temp') then
      new.asesor := nullif(yo, '');
    end if;
    if rol = 'asesor_temp' then
      new.es_prueba := true;
      select count(*) into hoy from public.pedidos
      where workspace_id = new.workspace_id and creado_por_id = auth.uid() and created_at >= current_date;
      if hoy >= 10 then
        raise exception 'Llegaste al límite de 10 pedidos de prueba por día.';
      end if;
    end if;
    if rol in ('asesor', 'asesor_temp') and not public.estado_libre(new.estado) then
      raise exception 'Un pedido nuevo tiene que empezar en Volver a llamar, Coordinación, Confirmado, NC o Rechazado.';
    end if;
    return new;
  end if;

  -- UPDATE de alguien que no es admin.
  if new.codigo is distinct from old.codigo then
    raise exception 'Solo el administrador puede cambiar el código.';
  end if;
  new.creado_por := old.creado_por;
  new.creado_por_id := old.creado_por_id;
  new.es_prueba := old.es_prueba;

  if rol in ('asesor', 'asesor_temp') and new.estado is distinct from old.estado
     and not (public.estado_libre(old.estado) and public.estado_libre(new.estado)) then
    raise exception 'Ese cambio de estado necesita autorización del administrador.';
  end if;

  -- El primer encargado que gestiona un pedido sin encargado se lo queda.
  if rol = 'encargado' and coalesce(old.encargado, '') = '' and yo <> '' then
    new.encargado := yo;
    new.fecha_asig_encargado := now();
  end if;

  return new;
end;
$$;

drop trigger if exists pedidos_antes_de_guardar on public.pedidos;
create trigger pedidos_antes_de_guardar
  before insert or update on public.pedidos
  for each row execute function public.pedidos_antes_de_guardar();

-- Anota en el historial cada alta y cada cambio, campo por campo.
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
      and n.key not in ('updated_at', 'ultima_gestion', 'busqueda', 'fecha_estado', 'fecha_primera_gestion')
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

drop trigger if exists pedidos_anotar_historial on public.pedidos;
create trigger pedidos_anotar_historial
  after insert or update on public.pedidos
  for each row execute function public.pedidos_anotar_historial();

-- Quien pide la autorización queda anotado con su alias (o su mail).
create or replace function public.autorizaciones_anotar_solicitante()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.solicitante := coalesce(
    nullif(public.mi_alias(new.workspace_id), ''),
    (select email from auth.users where id = auth.uid()),
    new.solicitante
  );
  return new;
end;
$$;

drop trigger if exists autorizaciones_anotar_solicitante on public.autorizaciones;
create trigger autorizaciones_anotar_solicitante
  before insert on public.autorizaciones
  for each row execute function public.autorizaciones_anotar_solicitante();

-- El admin aprueba o rechaza un pedido de cambio de estado.
create or replace function public.resolver_autorizacion(autorizacion uuid, aprobar boolean, nota text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  fila public.autorizaciones;
begin
  select * into fila from public.autorizaciones where id = autorizacion;
  if fila.id is null then
    raise exception 'No se encontró la solicitud.';
  end if;
  if public.rol_de_venta(fila.workspace_id) is distinct from 'admin' then
    raise exception 'Solo un administrador puede resolver autorizaciones.';
  end if;
  if fila.estado <> 'pendiente' then
    raise exception 'Esa solicitud ya fue resuelta.';
  end if;

  if aprobar then
    update public.pedidos set estado = fila.estado_solicitado where id = fila.pedido_id;
  end if;

  update public.autorizaciones
  set estado = case when aprobar then 'aprobada' else 'rechazada' end,
      resuelto_por = coalesce(nullif(public.mi_alias(fila.workspace_id), ''), (select email from auth.users where id = auth.uid())),
      resuelto_at = now(),
      nota_resolucion = nullif(trim(nota), '')
  where id = autorizacion;
end;
$$;

-- Carga (o actualiza) pedidos de la planilla, de a tandas.
--
-- `filas` es un arreglo de objetos con las mismas claves que las columnas de
-- `pedidos`, más `items`: {"SOLUBRE": 3, "CHISGUETE": 1}. Si el código ya
-- existe, se pisa con lo que trae la planilla.
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
  select ws, coalesce(max((substring(codigo from '(\d+)$'))::integer), 1000)
  from public.pedidos where workspace_id = ws and codigo ~ '\d+$'
  on conflict (workspace_id) do update set ultimo = greatest(public.pedido_contadores.ultimo, excluded.ultimo);

  return cuantos;
end;
$$;

/* -------------------------------------------------------------------- RLS */

alter table public.productos enable row level security;
alter table public.pedido_contadores enable row level security;
alter table public.pedidos enable row level security;
alter table public.pedido_items enable row level security;
alter table public.pedido_historial enable row level security;
alter table public.autorizaciones enable row level security;

drop policy if exists "productos: ver" on public.productos;
create policy "productos: ver" on public.productos for select to authenticated
  using (public.is_workspace_member(workspace_id));
drop policy if exists "productos: admin" on public.productos;
create policy "productos: admin" on public.productos for all to authenticated
  using (public.rol_de_venta(workspace_id) = 'admin')
  with check (public.rol_de_venta(workspace_id) = 'admin');

-- Quién ve un pedido:
--   admin     → todos;
--   encargado → los suyos y los CONFIRMADOS que nadie tomó todavía;
--   asesor    → los que creó o tiene asignados.
drop policy if exists "pedidos: ver" on public.pedidos;
create policy "pedidos: ver" on public.pedidos for select to authenticated
  using (
    public.rol_de_venta(workspace_id) = 'admin'
    or (
      public.rol_de_venta(workspace_id) is not null
      and (
        creado_por_id = auth.uid()
        or (
          public.mi_alias(workspace_id) <> ''
          and public.mi_alias(workspace_id) in (
            upper(coalesce(creado_por, '')), upper(coalesce(asignado_a, '')),
            upper(coalesce(asesor, '')), upper(coalesce(encargado, ''))
          )
        )
        or (
          public.rol_de_venta(workspace_id) = 'encargado'
          and estado = 'CONFIRMADO' and coalesce(encargado, '') = '' and not es_prueba
        )
      )
    )
  );

drop policy if exists "pedidos: crear" on public.pedidos;
create policy "pedidos: crear" on public.pedidos for insert to authenticated
  with check (public.rol_de_venta(workspace_id) is not null);

drop policy if exists "pedidos: editar" on public.pedidos;
create policy "pedidos: editar" on public.pedidos for update to authenticated
  using (
    public.rol_de_venta(workspace_id) = 'admin'
    or (
      public.rol_de_venta(workspace_id) is not null
      and (
        creado_por_id = auth.uid()
        or (
          public.mi_alias(workspace_id) <> ''
          and public.mi_alias(workspace_id) in (
            upper(coalesce(creado_por, '')), upper(coalesce(asignado_a, '')),
            upper(coalesce(asesor, '')), upper(coalesce(encargado, ''))
          )
        )
        or (
          public.rol_de_venta(workspace_id) = 'encargado'
          and estado = 'CONFIRMADO' and coalesce(encargado, '') = '' and not es_prueba
        )
      )
    )
  )
  with check (public.rol_de_venta(workspace_id) is not null);

drop policy if exists "pedidos: borrar" on public.pedidos;
create policy "pedidos: borrar" on public.pedidos for delete to authenticated
  using (public.rol_de_venta(workspace_id) = 'admin');

-- Los productos de un pedido siguen al pedido: si lo ves, ves lo que lleva.
drop policy if exists "pedido_items: todo" on public.pedido_items;
create policy "pedido_items: todo" on public.pedido_items for all to authenticated
  using (exists (select 1 from public.pedidos p where p.id = pedido_id))
  with check (exists (select 1 from public.pedidos p where p.id = pedido_id and p.workspace_id = pedido_items.workspace_id));

drop policy if exists "pedido_historial: ver" on public.pedido_historial;
create policy "pedido_historial: ver" on public.pedido_historial for select to authenticated
  using (exists (select 1 from public.pedidos p where p.id = pedido_id));

drop policy if exists "autorizaciones: ver" on public.autorizaciones;
create policy "autorizaciones: ver" on public.autorizaciones for select to authenticated
  using (public.rol_de_venta(workspace_id) = 'admin' or solicitante_id = auth.uid());

drop policy if exists "autorizaciones: pedir" on public.autorizaciones;
create policy "autorizaciones: pedir" on public.autorizaciones for insert to authenticated
  with check (
    solicitante_id = auth.uid()
    and estado = 'pendiente'
    and exists (select 1 from public.pedidos p where p.id = pedido_id and p.workspace_id = autorizaciones.workspace_id)
  );

-- pedido_contadores no tiene políticas: sólo lo tocan las funciones de arriba.

grant execute on function public.rol_de_venta(uuid) to authenticated;
grant execute on function public.mi_alias(uuid) to authenticated;
grant execute on function public.guardar_miembro_de_venta(uuid, uuid, text, text) to authenticated;
grant execute on function public.siguiente_codigo(uuid) to authenticated;
grant execute on function public.resolver_autorizacion(uuid, boolean, text) to authenticated;
grant execute on function public.importar_pedidos(uuid, jsonb) to authenticated;

/* -------------------------------------------------- productos de arranque */

insert into public.productos (workspace_id, nombre, orden)
select w.id, p.nombre, p.orden
from public.workspaces w
cross join (values
  ('SOLUBRE', 1), ('BROCHAS', 2), ('LIMPIAXPRESS', 3), ('MILDREW', 4), ('HYPERCLEAN', 5),
  ('CHISGUETE', 6), ('PAÑO', 7), ('CAJAS', 8), ('CEPILLO VERDE', 9), ('PIPIBYE', 10),
  ('CEPILLO DOBLE NEGRO', 11), ('PLUMON ROJO', 12), ('PLUMON BLANCO', 13)
) as p(nombre, orden)
on conflict (workspace_id, nombre) do nothing;

/* ------------------------------------------------- permisos de las tablas */

-- Los proyectos nuevos de Supabase ya no les dan permisos a las tablas solos.
-- Sin esto la base existe pero nadie la puede leer, y el CRM dice "Este mail
-- no tiene acceso". La seguridad la siguen poniendo las políticas RLS de cada
-- tabla; esto sólo abre la puerta para que esas reglas se apliquen.
grant usage on schema public to authenticated, service_role;
grant all on all tables in schema public to authenticated, service_role;
grant all on all sequences in schema public to authenticated, service_role;
grant execute on all functions in schema public to authenticated, service_role;
alter default privileges in schema public grant all on tables to authenticated, service_role;
alter default privileges in schema public grant all on sequences to authenticated, service_role;
alter default privileges in schema public grant execute on functions to authenticated, service_role;
