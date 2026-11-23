-- La hora del CRM es la de Lima, y los mensajes de la base en tuteo.
--
-- La plantilla venía con Buenos Aires (UTC-3), dos horas adelante de Lima
-- (UTC-5): el historial y "hoy" quedaban corridos. Se cambia el valor por
-- omisión y el workspace que todavía tenía el de la plantilla. Si alguien ya
-- eligió otra zona en Configuración, se respeta.
alter table public.workspaces alter column timezone set default 'America/Lima';

update public.workspaces
set timezone = 'America/Lima'
where timezone = 'America/Argentina/Buenos_Aires';


-- Los mensajes de error de la base, en español peruano (tuteo). Se vuelven a
-- crear las funciones que los arman; la lógica no cambia.

create or replace function public.guard_contact_assignment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- `auth.uid()` es null en los trabajos de servidor (el webhook entra con la
  -- service role key). Ahí no hay sesión que controlar y la guarda no aplica.
  if auth.uid() is not null
     and new.assigned_to is distinct from old.assigned_to
     and not public.has_permission(new.workspace_id, 'asignar_leads') then
    raise exception 'No tienes permiso para cambiar el responsable de un lead.';
  end if;
  return new;
end;
$$;

create or replace function public.guard_tarea()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  actor uuid := auth.uid();
  cambia_responsable boolean;
begin
  if tg_op = 'UPDATE' then
    new.workspace_id := old.workspace_id;
    new.creada_por := old.creada_por;
    cambia_responsable := new.asignada_a is distinct from old.asignada_a;
  else
    cambia_responsable := true;
  end if;

  if new.contact_id is not null
     and (tg_op = 'INSERT' or new.contact_id is distinct from old.contact_id)
     and not exists (
       select 1 from public.contacts c
       where c.id = new.contact_id and c.workspace_id = new.workspace_id
     ) then
    raise exception 'Ese contacto no es de este workspace.';
  end if;

  if new.asignada_a is not null
     and (cambia_responsable or new.contact_id is distinct from old.contact_id) then
    if actor is not null
       and cambia_responsable
       and new.asignada_a <> actor
       and not public.has_permission(new.workspace_id, 'asignar_tareas') then
      raise exception 'No tienes permiso para darle tareas a otra persona.';
    end if;

    if not exists (
      select 1 from public.workspace_members m
      where m.workspace_id = new.workspace_id and m.user_id = new.asignada_a
    ) then
      raise exception 'Esa persona no es parte del equipo.';
    end if;

    if new.contact_id is not null
       and not public.miembro_ve_contacto(new.workspace_id, new.asignada_a, new.contact_id) then
      raise exception 'Esa persona no ve este lead. Asígnale el lead primero o elige a otra persona.';
    end if;
  end if;

  if cambia_responsable then
    new.vista := new.asignada_a is null or new.asignada_a is not distinct from actor;
  end if;

  -- Salvo que quien escribe ya diga qué hacer con el aviso: la app lo marca
  -- como salido cuando la hora nueva ya pasó, para no mandar un aviso de algo
  -- que se está cargando a sabiendas de que es para antes.
  if tg_op = 'UPDATE'
     and (new.aviso_at is distinct from old.aviso_at or new.vence_at is distinct from old.vence_at)
     and new.avisada_at is not distinct from old.avisada_at then
    new.avisada_at := null;
  end if;

  -- Al reabrirla se borra, así que al volver a marcarla hecha llega en null y
  -- toma la hora de ahora, que es la que importa.
  if new.estado = 'hecha' then
    new.completada_at := coalesce(new.completada_at, now());
  else
    new.completada_at := null;
  end if;

  return new;
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
    raise exception 'No eres parte de este equipo.';
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
