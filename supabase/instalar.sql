-- Instalación completa de la base del CRM, en un solo archivo.
--
-- Pegalo entero en el SQL Editor de un proyecto de Supabase NUEVO y tocá Run.
-- No lo corras en la base del CRM de producción.
--
-- Son las 45 migraciones de supabase/migrations/, en orden. No lo edites a
-- mano: se regenera con `npm run sql:instalar`.

-- =============================================================================
-- 202608150001_initial_crm.sql
-- =============================================================================

-- CRM de León: esquema inicial multi-tenant, con RLS habilitado.
create extension if not exists pgcrypto;

create type public.channel_type as enum ('whatsapp', 'instagram', 'messenger');
create type public.conversation_status as enum ('open', 'closed', 'pending');
create type public.sender_type as enum ('user', 'contact', 'ai');
create type public.opportunity_stage as enum ('new_lead', 'contacted', 'visit_scheduled', 'proposal', 'won', 'lost');
create type public.appointment_status as enum ('scheduled', 'completed', 'cancelled');

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'agent' check (role in ('owner', 'admin', 'agent')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  phone text,
  email text,
  avatar_url text,
  tags text[] not null default '{}',
  notes jsonb not null default '{}'::jsonb,
  bot_enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  channel public.channel_type not null,
  zernio_chat_id text not null,
  status public.conversation_status not null default 'open',
  assigned_agent_id uuid references auth.users(id) on delete set null,
  unread_count integer not null default 0 check (unread_count >= 0),
  updated_at timestamptz not null default now(),
  unique (workspace_id, zernio_chat_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_type public.sender_type not null,
  content text not null default '',
  media_url text,
  zernio_message_id text unique,
  created_at timestamptz not null default now()
);

create table public.pipelines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null default 'Embudo principal',
  created_at timestamptz not null default now(),
  unique (workspace_id, name)
);

create table public.opportunities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  pipeline_id uuid references public.pipelines(id) on delete set null,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  stage public.opportunity_stage not null default 'new_lead',
  value numeric(12, 2) not null default 0 check (value >= 0),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  title text not null,
  start_time timestamptz not null,
  end_time timestamptz not null,
  google_event_id text,
  status public.appointment_status not null default 'scheduled',
  created_at timestamptz not null default now(),
  check (end_time > start_time),
  unique (workspace_id, google_event_id)
);

create table public.ai_agent_configs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  channel public.channel_type not null,
  system_prompt text not null default '',
  tools_config jsonb not null default '{"catalog_search": true, "schedule_appointment": true, "handoff_to_human": true}'::jsonb,
  model_version text not null default 'gpt-5',
  updated_at timestamptz not null default now(),
  unique (workspace_id, channel)
);

create index contacts_workspace_created_idx on public.contacts (workspace_id, created_at desc);
create index conversations_workspace_updated_idx on public.conversations (workspace_id, updated_at desc);
create index conversations_contact_idx on public.conversations (contact_id);
create index messages_conversation_created_idx on public.messages (conversation_id, created_at);
create index opportunities_workspace_stage_idx on public.opportunities (workspace_id, stage);
create index appointments_workspace_start_idx on public.appointments (workspace_id, start_time);

create or replace function public.touch_updated_at()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger conversations_touch_updated_at before update on public.conversations for each row execute function public.touch_updated_at();
create trigger opportunities_touch_updated_at before update on public.opportunities for each row execute function public.touch_updated_at();
create trigger ai_agent_configs_touch_updated_at before update on public.ai_agent_configs for each row execute function public.touch_updated_at();

create or replace function public.is_workspace_member(target_workspace uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members where workspace_id = target_workspace and user_id = auth.uid());
$$;
grant execute on function public.is_workspace_member(uuid) to authenticated;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.contacts enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.pipelines enable row level security;
alter table public.opportunities enable row level security;
alter table public.appointments enable row level security;
alter table public.ai_agent_configs enable row level security;

create policy "members read workspaces" on public.workspaces for select to authenticated using (public.is_workspace_member(id));
create policy "members read workspace members" on public.workspace_members for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "members manage contacts" on public.contacts for all to authenticated using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
create policy "members manage conversations" on public.conversations for all to authenticated using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
create policy "members manage messages" on public.messages for all to authenticated using (exists (select 1 from public.conversations c where c.id = conversation_id and public.is_workspace_member(c.workspace_id))) with check (exists (select 1 from public.conversations c where c.id = conversation_id and public.is_workspace_member(c.workspace_id)));
create policy "members manage pipelines" on public.pipelines for all to authenticated using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
create policy "members manage opportunities" on public.opportunities for all to authenticated using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
create policy "members manage appointments" on public.appointments for all to authenticated using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
create policy "members manage ai configs" on public.ai_agent_configs for all to authenticated using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

alter publication supabase_realtime add table public.conversations, public.messages;

-- =============================================================================
-- 202608170001_archive_contacts.sql
-- =============================================================================

-- Archivado de contactos (borrado suave).
--
-- `conversations.contact_id` y `appointments.contact_id` tienen ON DELETE
-- CASCADE: borrar un contacto de verdad destruiría sus chats y mensajes.
-- Para "ocultar sin eliminar", marcamos el contacto como archivado y la
-- aplicación filtra por `archived_at is null`. El historial queda intacto.

alter table public.contacts add column if not exists archived_at timestamptz;

-- Los listados siempre piden contactos activos ordenados por fecha.
create index if not exists contacts_workspace_active_idx
  on public.contacts (workspace_id, created_at desc)
  where archived_at is null;

-- =============================================================================
-- 202608170002_zernio_accounts.sql
-- =============================================================================

-- Mapeo de cuentas de Zernio a workspaces.
--
-- Los webhooks entrantes no traen sesión de usuario: hay que resolver a qué
-- workspace pertenece cada mensaje. Zernio identifica la cuenta social que
-- recibió el mensaje con `account.id`, así que ese es el puente.
--
-- Un workspace puede tener varias cuentas (una por canal), por eso es tabla
-- aparte y no una columna en `workspaces`.

create table if not exists public.zernio_accounts (
  zernio_account_id text primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  platform text,
  username text,
  created_at timestamptz not null default now()
);

create index if not exists zernio_accounts_workspace_idx
  on public.zernio_accounts (workspace_id);

alter table public.zernio_accounts enable row level security;

-- El webhook escribe con la service-role key, que omite RLS. Esta política
-- solo habilita a los miembros a ver y administrar sus propias cuentas.
create policy "members manage zernio accounts" on public.zernio_accounts
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- =============================================================================
-- 202608170003_contact_identities.sql
-- =============================================================================

-- Identidades de un contacto en cada canal.
--
-- La misma persona te puede escribir por WhatsApp, Instagram y Messenger. En
-- WhatsApp el teléfono alcanza para reconocerla, pero en Instagram y Messenger
-- no hay teléfono: el único identificador estable es el id que manda Zernio.
--
-- Sin esta tabla, cada canal creaba un contacto nuevo y el mismo lead aparecía
-- duplicado en el embudo. Es tabla aparte y no una columna en `contacts` para
-- que un contacto pueda tener varias identidades y se puedan fusionar después.

create table if not exists public.contact_identities (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  platform public.channel_type not null,
  external_id text not null,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (workspace_id, platform, external_id)
);

create index if not exists contact_identities_contact_idx
  on public.contact_identities (contact_id);

alter table public.contact_identities enable row level security;

-- El webhook escribe con la service-role key, que omite RLS. Esta política solo
-- habilita a los miembros a ver las identidades de su propio workspace.
create policy "members manage contact identities" on public.contact_identities
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- =============================================================================
-- 202608170004_conversation_account.sql
-- =============================================================================

-- Cuenta de Zernio por la que entró cada conversación.
--
-- Para responder hay que decirle a Zernio con qué cuenta mandar el mensaje: la
-- API exige `accountId` en el cuerpo. Un workspace puede tener varias cuentas
-- (WhatsApp, Instagram, Messenger, o dos números distintos), así que deducirlo
-- del canal no alcanza: se guarda el que vino en el webhook.

alter table public.conversations
  add column if not exists zernio_account_id text;

-- =============================================================================
-- 202608170005_pipeline_stages.sql
-- =============================================================================

-- Las etapas del embudo dejan de ser un tipo de Postgres y pasan a ser datos.
--
-- Con el enum `opportunity_stage` no se podía agregar, renombrar ni borrar una
-- columna del embudo sin tocar el esquema. Esta migración las mueve a una
-- tabla por workspace, migra las oportunidades existentes y recién ahí elimina
-- el enum. Es idempotente sólo hasta el `drop column`: correrla dos veces es
-- inofensivo porque la segunda no encuentra la columna vieja.

create table if not exists public.pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 40),
  position integer not null,
  -- `kind` es lo que hace que las métricas sigan funcionando después de que el
  -- usuario renombre las columnas: "Ganado" puede pasar a llamarse "Cerrado"
  -- sin que la tasa de conversión deje de contarlo.
  kind text not null default 'open' check (kind in ('open', 'won', 'lost')),
  created_at timestamptz not null default now()
);

create index if not exists pipeline_stages_workspace_position_idx
  on public.pipeline_stages (workspace_id, position);

alter table public.pipeline_stages enable row level security;

drop policy if exists "members manage pipeline stages" on public.pipeline_stages;
create policy "members manage pipeline stages" on public.pipeline_stages
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- Siembra las seis etapas históricas en los workspaces que ya existen.
insert into public.pipeline_stages (workspace_id, name, position, kind)
select w.id, s.name, s.position, s.kind
from public.workspaces w
cross join (values
  ('Nuevo lead', 1, 'open'),
  ('Contactado', 2, 'open'),
  ('Visita coordinada', 3, 'open'),
  ('Propuesta', 4, 'open'),
  ('Ganado', 5, 'won'),
  ('Perdido', 6, 'lost')
) as s(name, position, kind)
where not exists (
  select 1 from public.pipeline_stages ps where ps.workspace_id = w.id
);

-- Todo workspace nuevo nace con el embudo por defecto. Va como trigger y no en
-- la app para que también lo hereden los que se crean desde SQL o desde el
-- webhook, sin depender de que alguien se acuerde de sembrarlos.
create or replace function public.seed_pipeline_stages()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.pipeline_stages (workspace_id, name, position, kind)
  values
    (new.id, 'Nuevo lead', 1, 'open'),
    (new.id, 'Contactado', 2, 'open'),
    (new.id, 'Visita coordinada', 3, 'open'),
    (new.id, 'Propuesta', 4, 'open'),
    (new.id, 'Ganado', 5, 'won'),
    (new.id, 'Perdido', 6, 'lost');
  return new;
end;
$$;

drop trigger if exists workspaces_seed_pipeline_stages on public.workspaces;
create trigger workspaces_seed_pipeline_stages
  after insert on public.workspaces
  for each row execute function public.seed_pipeline_stages();

-- `restrict` en lugar de `cascade`: borrar una etapa nunca debe borrar las
-- oportunidades que estaban adentro. La app las reubica antes de eliminarla.
alter table public.opportunities
  add column if not exists stage_id uuid references public.pipeline_stages(id) on delete restrict;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'opportunities' and column_name = 'stage'
  ) then
    update public.opportunities o
    set stage_id = ps.id
    from public.pipeline_stages ps
    where o.stage_id is null
      and ps.workspace_id = o.workspace_id
      and ps.position = case o.stage::text
        when 'new_lead' then 1
        when 'contacted' then 2
        when 'visit_scheduled' then 3
        when 'proposal' then 4
        when 'won' then 5
        when 'lost' then 6
      end;

    alter table public.opportunities drop column stage;
    drop type if exists public.opportunity_stage;
  end if;
end $$;

-- Red de seguridad: si quedó alguna oportunidad sin mapear (por ejemplo de un
-- workspace sin etapas), se la manda a la primera columna abierta antes de
-- exigir `not null`.
update public.opportunities o
set stage_id = (
  select ps.id from public.pipeline_stages ps
  where ps.workspace_id = o.workspace_id
  order by ps.position
  limit 1
)
where o.stage_id is null;

alter table public.opportunities alter column stage_id set not null;

create index if not exists opportunities_stage_idx on public.opportunities (stage_id);

-- =============================================================================
-- 202608170006_agent_enabled.sql
-- =============================================================================

-- Interruptor general por agente.
--
-- `contacts.bot_enabled` ya permitía frenar la IA en un lead puntual, pero no
-- había forma de apagar un canal entero sin vaciar sus instrucciones. Este
-- interruptor manda sobre el del lead: apagado el canal, la IA no habla con
-- nadie.
--
-- Arranca en `true` para no cambiar el comportamiento de lo que ya estaba
-- configurado: quien tenía instrucciones cargadas sigue respondiendo igual.
alter table public.ai_agent_configs
  add column if not exists enabled boolean not null default true;

-- =============================================================================
-- 202608170007_roles_y_permisos.sql
-- =============================================================================

-- Dos tipos de usuario: administrador y operario.
--
-- El administrador ve y hace todo, y además configura qué puede hacer cada
-- operario. El operario arranca sin nada: sólo ve los leads que le asignaron y
-- las columnas del embudo que le habilitaron, y cada acción (crear contactos,
-- borrarlos, editar el embudo, responder chats) es un permiso que se prende
-- uno por uno.
--
-- Todo se aplica en la base, no en la pantalla. Esconder un botón no protege
-- nada: cualquiera con la sesión abierta puede llamar a la API igual. Por eso
-- las reglas viven en las políticas RLS y la interfaz sólo las refleja.

-- ---------------------------------------------------------------------------
-- Columnas nuevas
-- ---------------------------------------------------------------------------

-- Los permisos del operario, uno por clave. Va como jsonb y no como columnas
-- para poder agregar permisos sin migrar la tabla cada vez. El administrador
-- no lo usa: su rol ya le da todo.
alter table public.workspace_members
  add column if not exists permissions jsonb not null default '{}'::jsonb;

-- El responsable del lead. Es lo que decide qué ve un operario.
alter table public.contacts
  add column if not exists assigned_to uuid references auth.users(id) on delete set null;

create index if not exists contacts_assigned_idx
  on public.contacts (workspace_id, assigned_to);

-- ---------------------------------------------------------------------------
-- Qué columnas del embudo ve cada operario
-- ---------------------------------------------------------------------------

-- Tabla y no un arreglo de ids en workspace_members: con la clave foránea,
-- borrar una columna del embudo limpia sola las habilitaciones que la
-- apuntaban. Con un arreglo quedarían ids muertos para siempre.
create table if not exists public.member_stage_access (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  stage_id uuid not null references public.pipeline_stages(id) on delete cascade,
  primary key (workspace_id, user_id, stage_id)
);

alter table public.member_stage_access enable row level security;

-- ---------------------------------------------------------------------------
-- Funciones de permiso
--
-- Todas son `security definer` a propósito: se las llama desde adentro de las
-- políticas RLS y necesitan leer workspace_members, contacts y pipeline_stages
-- sin volver a pasar por RLS. Si no, la política de una tabla dispararía la de
-- la otra y se caería en recursión infinita.
-- ---------------------------------------------------------------------------

create or replace function public.is_workspace_admin(target_workspace uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = target_workspace
      and user_id = auth.uid()
      and role in ('owner', 'admin')
  );
$$;

-- Un permiso suelto. El administrador los tiene todos sin cargarlos.
create or replace function public.has_permission(target_workspace uuid, perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = target_workspace
      and m.user_id = auth.uid()
      and (
        m.role in ('owner', 'admin')
        or coalesce((m.permissions ->> perm)::boolean, false)
      )
  );
$$;

-- Si el usuario puede ver un lead según quién sea su responsable.
--
-- Tres niveles: el operario siempre ve lo suyo; con `ver_leads_sin_asignar` ve
-- además la bolsa de leads nuevos que todavía no repartió nadie; con
-- `ver_todos_los_leads` ve el workspace entero.
create or replace function public.can_see_contact(target_workspace uuid, owner_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = target_workspace
      and m.user_id = auth.uid()
      and (
        m.role in ('owner', 'admin')
        or coalesce((m.permissions ->> 'ver_todos_los_leads')::boolean, false)
        or owner_id = auth.uid()
        or (owner_id is null
            and coalesce((m.permissions ->> 'ver_leads_sin_asignar')::boolean, false))
      )
  );
$$;

-- Lo mismo, pero partiendo del id del contacto. Lo usan chats y oportunidades.
create or replace function public.can_see_contact_row(target_contact uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.contacts c
    where c.id = target_contact
      and public.can_see_contact(c.workspace_id, c.assigned_to)
  );
$$;

create or replace function public.can_see_conversation(target_conversation uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.conversations v
    where v.id = target_conversation
      and public.is_workspace_member(v.workspace_id)
      and public.can_see_contact_row(v.contact_id)
  );
$$;

-- Si el usuario puede ver una columna del embudo.
--
-- Sin filas cargadas en member_stage_access el operario ve el embudo completo:
-- el default es no restringir, para que agregar un usuario no lo deje mirando
-- una pantalla vacía. Restringir es una decisión explícita del administrador.
--
-- La primera columna se ve siempre. Es donde caen los leads nuevos, y si un
-- operario no la viera no podría cargar un contacto: la oportunidad que se
-- crea con él apunta justamente ahí.
create or replace function public.can_see_stage(target_workspace uuid, target_stage uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select
    public.is_workspace_admin(target_workspace)
    or not exists (
      select 1 from public.member_stage_access a
      where a.workspace_id = target_workspace and a.user_id = auth.uid()
    )
    or exists (
      select 1 from public.member_stage_access a
      where a.workspace_id = target_workspace
        and a.user_id = auth.uid()
        and a.stage_id = target_stage
    )
    or target_stage = (
      select ps.id from public.pipeline_stages ps
      where ps.workspace_id = target_workspace
      order by ps.position
      limit 1
    );
$$;

grant execute on function public.is_workspace_admin(uuid) to authenticated;
grant execute on function public.has_permission(uuid, text) to authenticated;
grant execute on function public.can_see_contact(uuid, uuid) to authenticated;
grant execute on function public.can_see_contact_row(uuid) to authenticated;
grant execute on function public.can_see_conversation(uuid) to authenticated;
grant execute on function public.can_see_stage(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Reasignar un lead es un permiso aparte
--
-- La política de UPDATE no alcanza para esto: mira la fila vieja y la nueva por
-- separado, así que un operario podría ponerse a sí mismo como responsable de
-- un lead que ya ve y quedárselo. El trigger compara los dos valores.
-- ---------------------------------------------------------------------------

create or replace function public.guard_contact_assignment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- `auth.uid()` es null en los trabajos de servidor (el webhook entra con la
  -- service role key). Ahí no hay sesión que controlar y la guarda no aplica.
  if auth.uid() is not null
     and new.assigned_to is distinct from old.assigned_to
     and not public.has_permission(new.workspace_id, 'asignar_leads') then
    raise exception 'No tenés permiso para cambiar el responsable de un lead.';
  end if;
  return new;
end;
$$;

drop trigger if exists contacts_guard_assignment on public.contacts;
create trigger contacts_guard_assignment
  before update on public.contacts
  for each row execute function public.guard_contact_assignment();

-- ---------------------------------------------------------------------------
-- Políticas
--
-- Las de antes eran todas `for all` con la sola condición de ser miembro del
-- workspace. Se reemplazan por una por operación, porque leer y borrar ya no
-- piden lo mismo.
-- ---------------------------------------------------------------------------

-- Miembros del workspace ------------------------------------------------------

drop policy if exists "members read workspace members" on public.workspace_members;
create policy "members read workspace members" on public.workspace_members
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

drop policy if exists "admins manage workspace members" on public.workspace_members;
create policy "admins manage workspace members" on public.workspace_members
  for all to authenticated
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

-- Habilitación de columnas ----------------------------------------------------

drop policy if exists "members read own stage access" on public.member_stage_access;
create policy "members read own stage access" on public.member_stage_access
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.is_workspace_admin(workspace_id)
  );

drop policy if exists "admins manage stage access" on public.member_stage_access;
create policy "admins manage stage access" on public.member_stage_access
  for all to authenticated
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

-- Contactos -------------------------------------------------------------------

drop policy if exists "members manage contacts" on public.contacts;

drop policy if exists "read visible contacts" on public.contacts;
create policy "read visible contacts" on public.contacts
  for select to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and public.can_see_contact(workspace_id, assigned_to)
  );

drop policy if exists "create contacts with permission" on public.contacts;
create policy "create contacts with permission" on public.contacts
  for insert to authenticated
  with check (public.has_permission(workspace_id, 'crear_contactos'));

drop policy if exists "update visible contacts" on public.contacts;
create policy "update visible contacts" on public.contacts
  for update to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and public.can_see_contact(workspace_id, assigned_to)
  )
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "delete contacts with permission" on public.contacts;
create policy "delete contacts with permission" on public.contacts
  for delete to authenticated
  using (
    public.has_permission(workspace_id, 'eliminar_contactos')
    and public.can_see_contact(workspace_id, assigned_to)
  );

-- Conversaciones y mensajes ---------------------------------------------------

drop policy if exists "members manage conversations" on public.conversations;

drop policy if exists "read visible conversations" on public.conversations;
create policy "read visible conversations" on public.conversations
  for select to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and public.can_see_contact_row(contact_id)
  );

drop policy if exists "write visible conversations" on public.conversations;
create policy "write visible conversations" on public.conversations
  for all to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and public.can_see_contact_row(contact_id)
  )
  with check (
    public.is_workspace_member(workspace_id)
    and public.can_see_contact_row(contact_id)
  );

drop policy if exists "members manage messages" on public.messages;

drop policy if exists "read visible messages" on public.messages;
create policy "read visible messages" on public.messages
  for select to authenticated
  using (public.can_see_conversation(conversation_id));

drop policy if exists "send messages with permission" on public.messages;
create policy "send messages with permission" on public.messages
  for insert to authenticated
  with check (
    public.can_see_conversation(conversation_id)
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id
        and public.has_permission(c.workspace_id, 'responder_chats')
    )
  );

drop policy if exists "update visible messages" on public.messages;
create policy "update visible messages" on public.messages
  for update to authenticated
  using (public.can_see_conversation(conversation_id))
  with check (public.can_see_conversation(conversation_id));

-- Embudo ----------------------------------------------------------------------

drop policy if exists "members manage pipeline stages" on public.pipeline_stages;

drop policy if exists "read allowed stages" on public.pipeline_stages;
create policy "read allowed stages" on public.pipeline_stages
  for select to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and public.can_see_stage(workspace_id, id)
  );

drop policy if exists "edit pipeline with permission" on public.pipeline_stages;
create policy "edit pipeline with permission" on public.pipeline_stages
  for all to authenticated
  using (public.has_permission(workspace_id, 'editar_embudo'))
  with check (public.has_permission(workspace_id, 'editar_embudo'));

drop policy if exists "members manage opportunities" on public.opportunities;

-- Una oportunidad se ve si se ve el lead y además la columna donde está. Mover
-- una tarjeta a una columna que no ves no se puede: el `with check` la frena.
drop policy if exists "read visible opportunities" on public.opportunities;
create policy "read visible opportunities" on public.opportunities
  for select to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and public.can_see_contact_row(contact_id)
    and public.can_see_stage(workspace_id, stage_id)
  );

drop policy if exists "write visible opportunities" on public.opportunities;
create policy "write visible opportunities" on public.opportunities
  for all to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and public.can_see_contact_row(contact_id)
    and public.can_see_stage(workspace_id, stage_id)
  )
  with check (
    public.is_workspace_member(workspace_id)
    and public.can_see_contact_row(contact_id)
    and public.can_see_stage(workspace_id, stage_id)
  );

-- Agenda ----------------------------------------------------------------------

drop policy if exists "members manage appointments" on public.appointments;

drop policy if exists "read visible appointments" on public.appointments;
create policy "read visible appointments" on public.appointments
  for select to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and public.can_see_contact_row(contact_id)
  );

drop policy if exists "manage appointments with permission" on public.appointments;
create policy "manage appointments with permission" on public.appointments
  for all to authenticated
  using (
    public.has_permission(workspace_id, 'gestionar_agenda')
    and public.can_see_contact_row(contact_id)
  )
  with check (
    public.has_permission(workspace_id, 'gestionar_agenda')
    and public.can_see_contact_row(contact_id)
  );

-- Agentes IA ------------------------------------------------------------------

drop policy if exists "members manage ai configs" on public.ai_agent_configs;

drop policy if exists "read ai configs" on public.ai_agent_configs;
create policy "read ai configs" on public.ai_agent_configs
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

drop policy if exists "manage ai configs with permission" on public.ai_agent_configs;
create policy "manage ai configs with permission" on public.ai_agent_configs
  for all to authenticated
  using (public.has_permission(workspace_id, 'gestionar_agentes'))
  with check (public.has_permission(workspace_id, 'gestionar_agentes'));

-- ---------------------------------------------------------------------------
-- El primero que entró al workspace queda como administrador
--
-- Antes el rol default era 'agent' y nadie lo miraba. Con esta migración el rol
-- pasa a importar, así que el miembro más viejo de cada workspace se promueve a
-- 'owner': sin esto el dueño del CRM se quedaría afuera de su propia cuenta.
-- ---------------------------------------------------------------------------

update public.workspace_members m
set role = 'owner'
where m.role not in ('owner', 'admin')
  and m.created_at = (
    select min(x.created_at) from public.workspace_members x
    where x.workspace_id = m.workspace_id
  );

-- =============================================================================
-- 202608170008_herramientas_agente.sql
-- =============================================================================

-- Queda una sola herramienta del agente: derivar a una persona.
--
-- `catalog_search` y `schedule_appointment` se dibujaban en el panel y se
-- guardaban acá, pero ningún pedido a OpenAI las miraba: eran interruptores que
-- no apagaban nada. La derivación sí hace algo — frena la IA para ese contacto
-- y deja el chat pendiente — así que es la única que sobrevive.
--
-- Esto es sólo limpieza. La app ya descarta las claves muertas al leer, así que
-- correrla o no correrla no cambia cómo se comporta el agente.

alter table public.ai_agent_configs
  alter column tools_config set default '{"handoff_to_human": true}'::jsonb;

update public.ai_agent_configs
set tools_config = jsonb_build_object(
  'handoff_to_human',
  coalesce((tools_config ->> 'handoff_to_human')::boolean, true)
)
where tools_config ? 'catalog_search'
   or tools_config ? 'schedule_appointment'
   or not (tools_config ? 'handoff_to_human');

-- =============================================================================
-- 202608170009_realtime.sql
-- =============================================================================

-- Que los mensajes nuevos aparezcan sin recargar la página.
--
-- Realtime manda por el socket lo que sale del WAL de Postgres, y con RLS
-- prendido tiene que decidir, fila por fila, si ese usuario podía leerla. Para
-- decidirlo necesita la fila entera. Por defecto Postgres sólo publica la clave
-- primaria en los UPDATE y los DELETE (`replica identity default`), así que a
-- Realtime le llega un id pelado, no puede evaluar la política y descarta el
-- evento en silencio: la pantalla se queda quieta y no hay error en ningún lado.
--
-- `replica identity full` publica la fila completa y arregla eso. Cuesta un
-- poco más de WAL por escritura, que en tablas de esta escala no se nota.
--
-- Los UPDATE importan acá y no son un detalle: cuando entra un audio o una foto
-- el mensaje se guarda primero con un marcador y unos segundos después el
-- webhook lo reemplaza por la transcripción. Ese reemplazo es un UPDATE.

alter table public.messages replica identity full;
alter table public.conversations replica identity full;

-- La publicación se creó en la migración inicial, pero conviene reafirmarla:
-- restaurar la base desde un backup o recrear la tabla la deja afuera, y el
-- síntoma es exactamente el mismo — todo funciona salvo el vivo.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversations'
  ) then
    alter publication supabase_realtime add table public.conversations;
  end if;
end $$;

-- =============================================================================
-- 202608180001_conversation_provider.sql
-- =============================================================================

-- Proveedor de mensajería por el que entró cada conversación.
--
-- Hasta acá todo llegaba por Zernio y responder era llamar directo a su API.
-- Al sumar un segundo proveedor hay que saber por dónde contestar cada charla,
-- y el canal no alcanza: WhatsApp puede entrar por cualquiera de los dos.
--
-- Es `text` con check y no un enum a propósito: sumar un proveedor más adelante
-- es cambiar la restricción, no alterar un tipo del que cuelgan columnas.
--
-- El default cubre lo que ya existe sin backfill: toda conversación anterior a
-- esta migración es de Zernio por definición.
alter table public.conversations
  add column if not exists provider text not null default 'zernio';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'conversations_provider_check'
  ) then
    alter table public.conversations
      add constraint conversations_provider_check
      check (provider in ('zernio', 'ycloud'));
  end if;
end $$;

-- `zernio_chat_id` y `zernio_account_id` quedaron con ese nombre por historia,
-- pero ya no son de Zernio: son las coordenadas del proveedor que sea. Para
-- Zernio, el id de conversación y el de cuenta social. Para YCloud, el teléfono
-- del contacto en E.164 y el número propio desde el que se envía.
comment on column public.conversations.zernio_chat_id is
  'Id de la conversación en el proveedor. En YCloud, el teléfono del contacto en E.164.';
comment on column public.conversations.zernio_account_id is
  'Cuenta del proveedor por la que entró. En YCloud, el número propio que recibe.';

-- =============================================================================
-- 202608190001_workspace_timezone.sql
-- =============================================================================

-- Zona horaria del workspace.
--
-- Vercel corre en UTC y el resumen armaba los días con la fecha del servidor:
-- a las 21:00 de Argentina ya era el día siguiente allá, así que el gráfico de
-- actividad abría una barra de mañana y metía ahí los mensajes de hoy. Quien
-- miraba veía leads en un día que todavía no había empezado.
--
-- El corte del día lo tiene que decidir el equipo, no la máquina donde toca
-- desplegar, así que la zona viaja con el workspace.

alter table public.workspaces
  add column if not exists timezone text not null default 'America/Argentina/Buenos_Aires';

-- `workspaces` sólo tenía policy de lectura: sin esto, guardar la zona desde
-- Configuración fallaba con un error de RLS.
drop policy if exists "admins update workspaces" on public.workspaces;
create policy "admins update workspaces" on public.workspaces
  for update to authenticated
  using (public.is_workspace_admin(id))
  with check (public.is_workspace_admin(id));

-- =============================================================================
-- 202608210002_metricas_resumen.sql
-- =============================================================================

-- Las métricas del Resumen dejan de contarse a ojo.
--
-- Hasta acá cada tarjeta se calculaba en la aplicación sobre las filas que ya
-- estaban traídas para pintar las otras secciones, y eso tenía dos problemas.
--
-- El primero es que esas filas vienen paginadas: "Contactos" hacía
-- `contacts.length` sobre una consulta con `limit(200)`, así que del contacto
-- 201 en adelante el número se congelaba y nadie se enteraba. Lo mismo con los
-- no leídos, que sumaban sobre las 50 conversaciones más recientes.
--
-- El segundo es que hay métricas que no se pueden calcular así ni trayendo todo:
-- el lapso de réplica necesita mirar cada mensaje contra el siguiente, y eso en
-- Postgres es una función de ventana y en la aplicación es traerse un mes de
-- mensajes a la memoria del servidor.
--
-- Por eso las cuentas bajan a la base, en una sola función que devuelve una
-- fila. Y por eso aparece el historial de etapas: "ganado este mes" se apoyaba
-- en `opportunities.updated_at`, que un trigger pisa en *cualquier* update, así
-- que tocarle el valor a una oportunidad cerrada en junio la volvía a contar
-- como ganada hoy.
--
-- Idempotente: se puede correr dos veces sin romper nada.

-- ---------------------------------------------------------------------------
-- Historial de etapas
--
-- Una fila por vez que una oportunidad cambia de columna. Es lo único que
-- permite preguntar "qué se ganó en julio" sin que la respuesta dependa de lo
-- que se haya editado después.
--
-- `kind` se copia en vez de leerse del join: el evento cuenta lo que pasó ese
-- día. Si mañana el usuario borra la columna "Ganado" o la reconvierte en una
-- etapa abierta, los cierres del mes pasado siguen habiendo sido cierres. Por
-- eso también `stage_id` es `on delete set null` y no `cascade`: se puede
-- perder el nombre de la columna, no el hecho.
-- ---------------------------------------------------------------------------

create table if not exists public.opportunity_stage_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  stage_id uuid references public.pipeline_stages(id) on delete set null,
  kind text not null check (kind in ('open', 'won', 'lost')),
  created_at timestamptz not null default now()
);

-- El índice que usa la métrica: los cierres de un workspace en un rango.
create index if not exists opportunity_stage_events_workspace_idx
  on public.opportunity_stage_events (workspace_id, kind, created_at);

create index if not exists opportunity_stage_events_opportunity_idx
  on public.opportunity_stage_events (opportunity_id, created_at);

-- `security definer` porque el trigger escribe la fila de auditoría en nombre
-- de quien movió la tarjeta, y esa persona no tiene —ni tiene que tener—
-- permiso de insertar acá a mano.
create or replace function public.log_opportunity_stage_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.stage_id is distinct from old.stage_id then
    insert into public.opportunity_stage_events (workspace_id, opportunity_id, stage_id, kind)
    select new.workspace_id, new.id, new.stage_id, coalesce(ps.kind, 'open')
    from public.pipeline_stages ps
    where ps.id = new.stage_id;
  end if;
  return new;
end;
$$;

drop trigger if exists opportunities_log_stage on public.opportunities;
create trigger opportunities_log_stage
  after insert or update of stage_id on public.opportunities
  for each row execute function public.log_opportunity_stage_change();

-- Siembra de lo que ya existe.
--
-- Es una aproximación y conviene saberlo: de las oportunidades viejas sólo se
-- conoce dónde están hoy y cuándo se las tocó por última vez, así que se
-- registra un único evento con esa fecha. Alcanza para que el tablero no
-- arranque en cero, y de acá en adelante el historial es exacto.
insert into public.opportunity_stage_events (workspace_id, opportunity_id, stage_id, kind, created_at)
select o.workspace_id, o.id, o.stage_id, ps.kind, o.updated_at
from public.opportunities o
join public.pipeline_stages ps on ps.id = o.stage_id
where not exists (
  select 1 from public.opportunity_stage_events e where e.opportunity_id = o.id
);

alter table public.opportunity_stage_events enable row level security;

-- Un evento se ve si se ve la oportunidad. `security definer` por lo mismo que
-- el resto de las funciones de permiso: se la llama desde adentro de una
-- política y no puede volver a disparar la de `opportunities`.
create or replace function public.can_see_opportunity(target_opportunity uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.opportunities o
    where o.id = target_opportunity
      and public.is_workspace_member(o.workspace_id)
      and public.can_see_contact_row(o.contact_id)
      and public.can_see_stage(o.workspace_id, o.stage_id)
  );
$$;

grant execute on function public.can_see_opportunity(uuid) to authenticated;

-- Sólo lectura: las filas las escribe el trigger. Nadie edita el historial.
drop policy if exists "leer historial de etapas" on public.opportunity_stage_events;
create policy "leer historial de etapas" on public.opportunity_stage_events
  for select to authenticated
  using (public.can_see_opportunity(opportunity_id));

-- ---------------------------------------------------------------------------
-- Un índice por fecha en los mensajes
--
-- El que había es `(conversation_id, created_at)`, perfecto para pintar un chat
-- y inútil para "todos los mensajes del mes", que es lo que pide el lapso de
-- réplica. Sin esto la función recorre la tabla entera cada vez que alguien
-- abre el tablero.
-- ---------------------------------------------------------------------------
create index if not exists messages_created_idx on public.messages (created_at);

-- ---------------------------------------------------------------------------
-- Las métricas del Resumen, en una sola ida
--
-- `security invoker`: la función corre con las políticas de quien la llama, así
-- que un operario que sólo ve sus leads ve las métricas de sus leads. Si fuera
-- `definer` el tablero le mostraría los números del workspace entero.
--
-- Los cortes de tiempo llegan resueltos desde la aplicación, que es la que
-- conoce la zona horaria del workspace: acá adentro no se decide qué es "hoy".
-- El tramo previo no es el mes pasado completo sino su mismo tramo —del 1 al
-- 21 si hoy es 21— porque comparar veintiún días contra treinta y uno hace que
-- todo parezca que se derrumbó.
-- ---------------------------------------------------------------------------
create or replace function public.metricas_resumen(
  p_workspace uuid,
  p_desde timestamptz,
  p_hasta timestamptz,
  p_previo_desde timestamptz,
  p_previo_hasta timestamptz
)
returns table (
  contactos bigint,
  leads_nuevos bigint,
  leads_nuevos_previos bigint,
  sin_leer bigint,
  sin_responder bigint,
  derivaciones bigint,
  ganado numeric,
  ganado_operaciones bigint,
  ganado_previo numeric,
  replica_peor numeric,
  replica_mediana numeric,
  replicas bigint,
  replica_peor_previa numeric
)
language sql stable security invoker set search_path = public as $$
with
-- Los chats de los que se habla en todo lo que sigue: los del workspace cuyo
-- contacto no está archivado. Archivar esconde a la persona de cada módulo, y
-- las métricas no pueden ser la excepción que la delate.
chats as (
  select v.id, v.status, v.unread_count, v.updated_at
  from public.conversations v
  join public.contacts c on c.id = v.contact_id
  where v.workspace_id = p_workspace
    and c.archived_at is null
),
-- Los mensajes del tramo, más una semana de colchón hacia atrás: la réplica a
-- un mensaje que entró el 31 a las 23:50 se responde en el mes siguiente, y sin
-- ese margen la espera más larga del mes es justo la que no se ve.
mensajes as (
  select m.conversation_id, m.sender_type, m.created_at
  from public.messages m
  join chats v on v.id = m.conversation_id
  where m.created_at >= p_previo_desde - interval '7 days'
    and m.created_at < p_hasta
),
-- Cuántas salidas hubo hasta cada mensaje. Es el truco que agrupa la
-- conversación en turnos: todos los mensajes seguidos del contacto comparten
-- número, y el primero que sale después lleva el siguiente. Emparejar los dos
-- da la espera, sin importar cuántas veces haya escrito la persona mientras
-- esperaba: se cuenta desde el primero, que es cuando empezó a esperar.
bloques as (
  select
    conversation_id,
    sender_type,
    created_at,
    sum(case when sender_type in ('user', 'ai') then 1 else 0 end) over (
      partition by conversation_id
      order by created_at
      rows between unbounded preceding and current row
    ) as bloque
  from mensajes
),
esperas as (
  select conversation_id, bloque, min(created_at) as consulta
  from bloques
  where sender_type = 'contact'
  group by conversation_id, bloque
),
-- Contesta la IA o contesta una persona: para quien está del otro lado la
-- espera terminó igual, y eso es lo que la métrica mide.
replicas_todas as (
  select
    r.created_at as respondido,
    extract(epoch from (r.created_at - e.consulta))::numeric as segundos
  from esperas e
  join bloques r
    on r.conversation_id = e.conversation_id
   and r.bloque = e.bloque + 1
   and r.sender_type in ('user', 'ai')
),
-- Se ordenan por cuándo se respondió y no por cuándo entró la consulta: la
-- pregunta es "cuánto hicimos esperar este mes".
replicas_mes as (
  select segundos from replicas_todas
  where respondido >= p_desde and respondido < p_hasta
),
replicas_previas as (
  select segundos from replicas_todas
  where respondido >= p_previo_desde and respondido < p_previo_hasta
),
-- Quién habló último en cada chat. Se acota a los abiertos de los últimos
-- noventa días: un chat cerrado no espera respuesta, y uno de hace un año
-- tampoco, pero haría crecer el recorrido para siempre.
ultimos as (
  select distinct on (m.conversation_id) m.conversation_id, m.sender_type
  from public.messages m
  join chats v on v.id = m.conversation_id
  where v.status <> 'closed'
    and v.updated_at >= p_hasta - interval '90 days'
  order by m.conversation_id, m.created_at desc
),
-- Una oportunidad puede entrar y salir de "Ganado" varias veces; cuenta la
-- primera vez que llegó dentro del tramo, así no se suma dos veces sola.
ganadas as (
  select distinct on (e.opportunity_id) e.opportunity_id, o.value
  from public.opportunity_stage_events e
  join public.opportunities o on o.id = e.opportunity_id
  where e.workspace_id = p_workspace
    and e.kind = 'won'
    and e.created_at >= p_desde
    and e.created_at < p_hasta
  order by e.opportunity_id, e.created_at
),
ganadas_previas as (
  select distinct on (e.opportunity_id) e.opportunity_id, o.value
  from public.opportunity_stage_events e
  join public.opportunities o on o.id = e.opportunity_id
  where e.workspace_id = p_workspace
    and e.kind = 'won'
    and e.created_at >= p_previo_desde
    and e.created_at < p_previo_hasta
  order by e.opportunity_id, e.created_at
),
activos as (
  select id, created_at from public.contacts
  where workspace_id = p_workspace and archived_at is null
)
select
  (select count(*) from activos),
  (select count(*) from activos where created_at >= p_desde and created_at < p_hasta),
  (select count(*) from activos where created_at >= p_previo_desde and created_at < p_previo_hasta),
  (select coalesce(sum(unread_count), 0)::bigint from chats),
  (select count(*) from ultimos where sender_type = 'contact'),
  (select count(*) from chats where status = 'pending'),
  (select coalesce(sum(value), 0)::numeric from ganadas),
  (select count(*) from ganadas),
  (select coalesce(sum(value), 0)::numeric from ganadas_previas),
  (select coalesce(max(segundos), 0)::numeric from replicas_mes),
  (select coalesce(
     percentile_cont(0.5) within group (order by segundos::double precision), 0
   )::numeric from replicas_mes),
  (select count(*) from replicas_mes),
  (select coalesce(max(segundos), 0)::numeric from replicas_previas);
$$;

grant execute on function public.metricas_resumen(uuid, timestamptz, timestamptz, timestamptz, timestamptz) to authenticated;

-- =============================================================================
-- 202608270001_push_notifications.sql
-- =============================================================================

-- Dispositivos que aceptaron recibir avisos de derivaciones.
--
-- Una suscripción pertenece a un usuario y a un workspace, pero el endpoint es
-- único: si dos personas usan el mismo navegador, la última sesión que activa
-- los avisos pasa a ser su dueña y no quedan alertas cruzadas.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_subscriptions_recipient_idx
  on public.push_subscriptions (workspace_id, user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists "users read own push subscriptions" on public.push_subscriptions;
create policy "users read own push subscriptions" on public.push_subscriptions
  for select to authenticated
  using (
    user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
  );

drop policy if exists "users create own push subscriptions" on public.push_subscriptions;
create policy "users create own push subscriptions" on public.push_subscriptions
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
  );

drop policy if exists "users update own push subscriptions" on public.push_subscriptions;
create policy "users update own push subscriptions" on public.push_subscriptions
  for update to authenticated
  using (
    user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
  )
  with check (
    user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
  );

drop policy if exists "users delete own push subscriptions" on public.push_subscriptions;
create policy "users delete own push subscriptions" on public.push_subscriptions
  for delete to authenticated
  using (
    user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
  );

-- =============================================================================
-- 202609190001_demora_agente.sql
-- =============================================================================

-- Cuánto tarda el agente en contestar, configurable por canal.
--
-- La demora estaba fija en el código: entre 3 y 9 segundos, proporcional al
-- largo de la respuesta. Dos motivos para sacarla de ahí. El primero es de
-- tono: un negocio que atiende consultas largas quiere parecer que las está
-- leyendo, y tres segundos para cuatro renglones delata al bot igual que
-- responder al instante.
--
-- El segundo es el que importa de verdad. Esa espera no es sólo cosmética: es
-- la ventana en la que se juntan los mensajes sueltos de una ráfaga —"hola",
-- "una consulta", "por el precio"— para contestarlos de una sola vez. Quien
-- estira la demora está estirando la ventana; quien la acorta, la acorta. Por
-- eso el piso es 2 segundos y no 0: sin espera no hay nada que agrupar y el
-- lead se come una respuesta por mensaje.
--
-- Los valores por defecto son exactamente los que estaban fijos, así que
-- correr esto no cambia el comportamiento de ningún workspace.

alter table public.ai_agent_configs
  add column if not exists reply_delay_min_seconds smallint not null default 3,
  add column if not exists reply_delay_max_seconds smallint not null default 9;

-- El rango se valida también en la app, pero el check es lo que impide que una
-- carga a mano en el panel de Supabase deje al agente esperando media hora.
alter table public.ai_agent_configs
  drop constraint if exists ai_agent_configs_reply_delay_range;

alter table public.ai_agent_configs
  add constraint ai_agent_configs_reply_delay_range
  check (
    reply_delay_min_seconds >= 2
    and reply_delay_max_seconds <= 60
    and reply_delay_max_seconds >= reply_delay_min_seconds
  );

-- =============================================================================
-- 202609190002_demora_agente_un_numero.sql
-- =============================================================================

-- La demora del agente pasa a ser un solo número.
--
-- La migración anterior la dejó como un rango, mínimo y máximo, porque la
-- espera vieja era proporcional al largo de la respuesta y necesitaba dos
-- topes. Pedirle eso a quien configura el agente es pedirle que entienda la
-- fórmula: lo que quiere contestar es "¿cuánto tarda?", y eso es un número.
--
-- El mínimo y el máximo no desaparecen, cambian de lugar: dejan de ser dos
-- campos para cargar y pasan a ser los límites de lo que se puede cargar, 2 y
-- 60 segundos, que el panel muestra al lado del campo.
--
-- Las filas que ya tengan un rango se quedan con su máximo, que es lo que esos
-- workspaces venían esperando en las respuestas largas.

alter table public.ai_agent_configs
  add column if not exists reply_delay_seconds smallint not null default 5;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'ai_agent_configs'
      and column_name = 'reply_delay_max_seconds'
  ) then
    update public.ai_agent_configs
    set reply_delay_seconds = greatest(2, least(60, reply_delay_max_seconds));
  end if;
end $$;

alter table public.ai_agent_configs
  drop constraint if exists ai_agent_configs_reply_delay_range;

alter table public.ai_agent_configs
  drop column if exists reply_delay_min_seconds,
  drop column if exists reply_delay_max_seconds;

-- El piso no es 0 a propósito: esa espera es la ventana en la que se agrupan
-- los mensajes sueltos de una ráfaga. Sin espera no hay nada que agrupar.
alter table public.ai_agent_configs
  drop constraint if exists ai_agent_configs_reply_delay;

alter table public.ai_agent_configs
  add constraint ai_agent_configs_reply_delay
  check (reply_delay_seconds between 2 and 60);

-- =============================================================================
-- 202609190003_asistente.sql
-- =============================================================================

-- El asistente del CRM: un chat interno que consulta los datos del workspace.
--
-- Dos columnas y nada más. No lleva tabla propia porque no guarda nada: la
-- conversación vive en la pantalla mientras está abierta y se va con ella. Eso
-- es a propósito —un historial de preguntas sobre leads es otro lugar donde se
-- acumulan datos de personas— y además hace que no haya nada que migrar,
-- limpiar ni exportar.
--
-- El interruptor es lo que importa. Cada pregunta al asistente son una o dos
-- llamadas a OpenAI, y a diferencia del agente de WhatsApp —que gasta cuando
-- escribe un cliente— éste gasta cuando alguien del equipo tiene curiosidad.
-- Tiene que poder apagarse sin tocar el código ni quitar la API key, que es
-- compartida con los agentes.

alter table public.workspaces
  add column if not exists assistant_enabled boolean not null default true,
  add column if not exists assistant_model text not null default 'gpt-5';

-- La policy de update ya existe desde la migración de la zona horaria
-- (202608190001), y es la misma que gobierna estas columnas: sólo un
-- administrador cambia la configuración del workspace. Se reafirma acá para
-- que correr esta migración sobre una base donde aquélla no llegó a aplicarse
-- no deje el interruptor imposible de guardar.
drop policy if exists "admins update workspaces" on public.workspaces;
create policy "admins update workspaces" on public.workspaces
  for update to authenticated
  using (public.is_workspace_admin(id))
  with check (public.is_workspace_admin(id));

-- =============================================================================
-- 202609200001_push_subscriptions_reparar.sql
-- =============================================================================

-- Repara una tabla de suscripciones creada antes de su forma actual.
--
-- `202608270001_push_notifications.sql` la crea con `create table if not exists`.
-- Cuando la tabla ya existía con otras columnas, ese create no hace nada y las
-- que faltan nunca aparecen: el alta de un dispositivo fallaba con
-- "Could not find the 'updated_at' column of 'push_subscriptions'".
--
-- Todo acá es idempotente: en una base que ya está bien, no cambia nada.

alter table public.push_subscriptions
  add column if not exists created_at timestamptz not null default now();

alter table public.push_subscriptions
  add column if not exists updated_at timestamptz not null default now();

-- El alta usa `onConflict: "endpoint"`, que necesita un índice único sobre esa
-- columna. Sin él, volver a abrir el CRM en el mismo navegador insertaría una
-- fila nueva en vez de refrescar la que ya está.
create unique index if not exists push_subscriptions_endpoint_key
  on public.push_subscriptions (endpoint);

create index if not exists push_subscriptions_recipient_idx
  on public.push_subscriptions (workspace_id, user_id);

-- =============================================================================
-- 202609240002_varios_embudos.sql
-- =============================================================================

-- Varios embudos por workspace.
--
-- Hasta acá las etapas colgaban del workspace: un solo embudo, y para separar
-- dos procesos que no se parecen —vender y dar posventa, por ejemplo— había que
-- mezclar sus columnas en la misma fila y filtrar a ojo.
--
-- La tabla `pipelines` existe desde la migración inicial y quedó sin usar
-- cuando las etapas pasaron de enum a datos. Esto la pone a trabajar: cada
-- etapa pasa a ser de un embudo, y el embudo de una oportunidad se deduce de su
-- etapa, que es el único lugar donde estaba escrito.
--
-- Un lead vive en un embudo por vez. Es lo que ya asumía todo el código —"la
-- etapa del contacto", en singular— y es además lo que hace entendible el
-- reparto: pasar un lead de Ventas a Posventa es moverlo, no duplicarlo.
--
-- Idempotente: se puede correr dos veces sin romper nada.

-- `pipelines` viene de la migración inicial. Se la vuelve a declarar por si un
-- proyecto se armó a mano y se saltó esa parte: si ya está, no pasa nada.
create table if not exists public.pipelines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null default 'Embudo principal',
  created_at timestamptz not null default now(),
  unique (workspace_id, name)
);

alter table public.pipelines enable row level security;

drop policy if exists "members manage pipelines" on public.pipelines;
create policy "members manage pipelines" on public.pipelines
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- El orden de los embudos, y con él cuál es el de entrada.
--
-- Se elige por posición y no por una columna `es_principal` para no tener que
-- sostener a mano la regla de que haya exactamente uno. El primero es donde
-- caen los leads nuevos, igual que la primera columna dentro de cada embudo: es
-- la misma convención, y así hay una sola que recordar.
alter table public.pipelines
  add column if not exists position integer not null default 1;

-- Todo workspace tiene que tener al menos uno, porque las etapas van a colgar
-- de ahí.
insert into public.pipelines (workspace_id, name, position)
select w.id, 'Embudo principal', 1
from public.workspaces w
where not exists (
  select 1 from public.pipelines p where p.workspace_id = w.id
);

-- La columna nace con todas las filas en 1. Un workspace que ya tuviera dos
-- embudos quedaría con dos "primeros", así que se renumeran por antigüedad
-- antes de que alguien los ordene.
with ordenados as (
  select id, row_number() over (partition by workspace_id order by created_at, id) as puesto
  from public.pipelines
)
update public.pipelines p
set position = ordenados.puesto
from ordenados
where ordenados.id = p.id
  and p.position is distinct from ordenados.puesto;

-- Sin `unique`, igual que las etapas: reordenar se hace fila por fila, y un
-- índice único abortaría a mitad de camino con dos filas pisando la misma
-- posición. El orden se desempata por `created_at`, que nunca repite.
create index if not exists pipelines_workspace_position_idx
  on public.pipelines (workspace_id, position);

/* --------------------------------------------------------- etapas por embudo */

alter table public.pipeline_stages
  add column if not exists pipeline_id uuid references public.pipelines(id) on delete cascade;

-- Las etapas que ya existían son todas del embudo que ya existía.
update public.pipeline_stages ps
set pipeline_id = (
  select p.id
  from public.pipelines p
  where p.workspace_id = ps.workspace_id
  order by p.position, p.created_at
  limit 1
)
where ps.pipeline_id is null;

alter table public.pipeline_stages
  alter column pipeline_id set not null;

-- La posición es dentro del embudo, no del workspace: dos embudos tienen los
-- dos su columna 1.
drop index if exists public.pipeline_stages_workspace_position_idx;
create index if not exists pipeline_stages_pipeline_position_idx
  on public.pipeline_stages (pipeline_id, position);

/* -------------------------------------------- el embudo de cada oportunidad */

-- `opportunities.pipeline_id` también viene de la migración inicial, y la
-- referencia era `on delete set null`: borrar un embudo dejaría tarjetas
-- apuntando a la nada. Pasa a `cascade`, que es lo que ya hace la etapa.
alter table public.opportunities
  add column if not exists pipeline_id uuid references public.pipelines(id) on delete cascade;

do $embudo_fk$
begin
  alter table public.opportunities drop constraint if exists opportunities_pipeline_id_fkey;
  alter table public.opportunities
    add constraint opportunities_pipeline_id_fkey
    foreign key (pipeline_id) references public.pipelines(id) on delete cascade;
end $embudo_fk$;

-- El embudo de una oportunidad no se escribe a mano en ningún lado: se deduce
-- de su etapa, que es el único lugar donde está la verdad. La columna existe
-- para poder filtrar sin un join, y el trigger es lo que garantiza que no se
-- desincronice —una tarjeta arrastrada a otro embudo se lleva su `pipeline_id`
-- sin que nadie se acuerde de actualizarlo—.
create or replace function public.sincronizar_embudo_de_oportunidad()
returns trigger language plpgsql security definer set search_path = public as $sincronizar$
begin
  select ps.pipeline_id into new.pipeline_id
  from public.pipeline_stages ps
  where ps.id = new.stage_id;
  return new;
end;
$sincronizar$;

drop trigger if exists opportunities_sincronizar_embudo on public.opportunities;
create trigger opportunities_sincronizar_embudo
  before insert or update of stage_id on public.opportunities
  for each row execute function public.sincronizar_embudo_de_oportunidad();

update public.opportunities o
set pipeline_id = ps.pipeline_id
from public.pipeline_stages ps
where ps.id = o.stage_id
  and o.pipeline_id is distinct from ps.pipeline_id;

create index if not exists opportunities_pipeline_idx
  on public.opportunities (pipeline_id);

/* ------------------------------------------------- el embudo de los nuevos */

-- Un workspace nuevo nace con su embudo y las seis etapas adentro. Va como
-- trigger y no en la app para que también lo hereden los workspaces que se
-- crean desde SQL o desde el webhook.
create or replace function public.seed_pipeline_stages()
returns trigger language plpgsql security definer set search_path = public as $seed$
declare
  embudo uuid;
begin
  insert into public.pipelines (workspace_id, name, position)
  values (new.id, 'Embudo principal', 1)
  returning id into embudo;

  insert into public.pipeline_stages (workspace_id, pipeline_id, name, position, kind)
  values
    (new.id, embudo, 'Nuevo lead', 1, 'open'),
    (new.id, embudo, 'Contactado', 2, 'open'),
    (new.id, embudo, 'Visita coordinada', 3, 'open'),
    (new.id, embudo, 'Propuesta', 4, 'open'),
    (new.id, embudo, 'Ganado', 5, 'won'),
    (new.id, embudo, 'Perdido', 6, 'lost');
  return new;
end;
$seed$;

/* ----------------------------------------------- permisos: una entrada por embudo */

-- `can_see_stage` eximía una sola columna: la primera del workspace. Era
-- correcto con un embudo y deja de serlo con dos, porque las dos primeras
-- comparten la posición 1 y el `limit 1` se queda con una sola —la que Postgres
-- devuelva—. Al operario con acceso restringido, los leads que entran al otro
-- embudo le desaparecían apenas caían.
--
-- Ahora se exime la primera columna de cada embudo, que es lo que la regla
-- quería decir desde el principio: donde caen los leads nuevos se ve siempre.
create or replace function public.can_see_stage(target_workspace uuid, target_stage uuid)
returns boolean language sql stable security definer set search_path = public as $ver_etapa$
  select
    public.is_workspace_admin(target_workspace)
    or not exists (
      select 1 from public.member_stage_access a
      where a.workspace_id = target_workspace and a.user_id = auth.uid()
    )
    or exists (
      select 1 from public.member_stage_access a
      where a.workspace_id = target_workspace
        and a.user_id = auth.uid()
        and a.stage_id = target_stage
    )
    or target_stage in (
      select distinct on (ps.pipeline_id) ps.id
      from public.pipeline_stages ps
      where ps.workspace_id = target_workspace
      order by ps.pipeline_id, ps.position
    );
$ver_etapa$;

grant execute on function public.can_see_stage(uuid, uuid) to authenticated;

comment on column public.pipelines.position is
  'Orden de los embudos. El primero es donde entran los leads nuevos.';
comment on column public.pipeline_stages.pipeline_id is
  'De qué embudo es la columna. La posición se cuenta dentro del embudo.';
comment on column public.opportunities.pipeline_id is
  'Se deduce de la etapa y lo mantiene un trigger. No se escribe a mano.';

-- =============================================================================
-- 202609240003_agente_por_embudo.sql
-- =============================================================================

-- Dos límites para el agente: en qué embudos contesta y cuándo se corre.
--
-- El primero llega con los embudos múltiples: el agente que califica leads de
-- Ventas no tiene nada que decirle a alguien que está en Posventa, y hasta acá
-- el único recorte posible era el canal.
--
-- El segundo es más viejo y más molesto. Cuando un vendedor entra a una
-- conversación, el agente le seguía escribiendo encima: el lead recibía dos
-- voces, a veces contradiciéndose. Frenarlo existía —el interruptor "IA activa"
-- de la ficha— pero había que acordarse de tocarlo antes de escribir, que es
-- exactamente cuando nadie se acuerda.
--
-- Idempotente: se puede correr dos veces sin romper nada.

-- Tabla y no un arreglo de ids en `ai_agent_configs`, por lo mismo que
-- `member_stage_access`: con la clave foránea, borrar un embudo limpia sola la
-- restricción que lo apuntaba. Con un arreglo quedaría un id muerto, y un
-- agente restringido a un embudo que ya no existe se queda mudo sin que nada lo
-- explique.
--
-- Sin filas, el agente contesta en todos los embudos. Es la misma convención
-- que los permisos por columna: no elegir es no restringir.
create table if not exists public.ai_agent_pipelines (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  config_id uuid not null references public.ai_agent_configs(id) on delete cascade,
  pipeline_id uuid not null references public.pipelines(id) on delete cascade,
  primary key (config_id, pipeline_id)
);

create index if not exists ai_agent_pipelines_workspace_idx
  on public.ai_agent_pipelines (workspace_id);

alter table public.ai_agent_pipelines enable row level security;

drop policy if exists "members read agent pipelines" on public.ai_agent_pipelines;
create policy "members read agent pipelines" on public.ai_agent_pipelines
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

-- Escribir queda para quien puede tocar los agentes, igual que la config: es la
-- misma decisión partida en dos tablas.
drop policy if exists "agent managers write agent pipelines" on public.ai_agent_pipelines;
create policy "agent managers write agent pipelines" on public.ai_agent_pipelines
  for all to authenticated
  using (public.has_permission(workspace_id, 'gestionar_agentes'))
  with check (public.has_permission(workspace_id, 'gestionar_agentes'));

-- Nace apagado: correr esto no cambia el comportamiento de ningún workspace.
-- Que el agente se calle solo es lo que se quiere casi siempre, pero decidirlo
-- por el usuario le cambiaría la atención de un día para el otro sin aviso.
alter table public.ai_agent_configs
  add column if not exists pause_on_human_reply boolean not null default false;

comment on table public.ai_agent_pipelines is
  'En qué embudos contesta cada agente. Sin filas, contesta en todos.';
comment on column public.ai_agent_configs.pause_on_human_reply is
  'Si al escribir una persona en el chat se apaga la IA de ese contacto.';

-- =============================================================================
-- 202609270001_citas_de_calendar.sql
-- =============================================================================

-- Citas que bajan de Google Calendar.
--
-- Calendar es la fuente de la verdad y la tarjeta del CRM es un espejo: el
-- vendedor agenda donde ya agenda, n8n avisa, y el CRM se entera. Eso define
-- casi todo lo que sigue.
--
-- Tres flujos:
--
--   alta    en Calendar -> nace la cita
--   cambio  de día u hora -> la cita se corrige
--   baja    -> la cita queda cancelada
--
-- La clave de todo es `appointments.google_event_id`, que ya existía sin usarse
-- desde la migración inicial, con su `unique (workspace_id, google_event_id)`.
-- Esa restricción es la que hace idempotente al webhook: n8n puede reintentar
-- el mismo POST y la base rechaza el duplicado.
--
-- Idempotente: se puede correr dos veces sin romper nada.

/* --------------------------------------------------------------- las citas */

-- Qué clase de cita es. Es lo que separa "recordatorio de llamada" de
-- "recordatorio de reunión" sin obligar a dos configuraciones.
--
-- Texto con check y no un enum de Postgres a propósito: agregar un valor a un
-- enum no se puede deshacer dentro de una transacción, y esta lista va a
-- crecer.
alter table public.appointments
  add column if not exists tipo text not null default 'reunion';

-- Quién manda sobre esta fila.
--
-- Sin esto no se puede distinguir una cita que bajó de Calendar de una que
-- alguien cargó a mano en el CRM, y la segunda quedaría expuesta a que la
-- sincronización la pise. Es la columna que hace convivir las dos formas de
-- agendar en la misma tabla.
alter table public.appointments
  add column if not exists origen text not null default 'manual';

-- El enlace al evento en Calendar, para poder abrirlo desde la agenda. Es el
-- `hangoutLink` o el `htmlLink` que ya viaja por n8n.
alter table public.appointments
  add column if not exists calendar_link text;

-- El teléfono tal como llegó del evento, ya normalizado a E.164.
--
-- Se guarda acá además de en `contacts.phone` porque son dos cosas distintas:
-- el del contacto es el que el equipo mantiene, y este es el que la persona
-- puso al reservar. Cuando no coinciden, esta columna es la que explica por qué
-- el recordatorio salió a donde salió.
alter table public.appointments
  add column if not exists telefono text;

-- La descripción del evento, que es de donde n8n saca el nombre y el teléfono.
-- Queda guardada para poder reconstruir qué se leyó cuando la extracción falle.
alter table public.appointments
  add column if not exists notas text;

alter table public.appointments
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'appointments_tipo_check') then
    alter table public.appointments
      add constraint appointments_tipo_check
      check (tipo in ('reunion', 'llamada', 'visita', 'otro'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'appointments_origen_check') then
    alter table public.appointments
      add constraint appointments_origen_check
      check (origen in ('manual', 'calendar'));
  end if;
end $$;

-- Lo que va a leer el barrido de recordatorios: las que vienen y siguen en pie.
create index if not exists appointments_proximas_idx
  on public.appointments (workspace_id, start_time)
  where status = 'scheduled';

comment on column public.appointments.origen is
  'Quién manda sobre la fila: calendar la sincroniza y sobrescribe, manual no se toca.';
comment on column public.appointments.tipo is
  'Clase de cita. El disparador de recordatorios filtra por acá.';
comment on column public.appointments.telefono is
  'Teléfono con el que se reservó, ya en E.164. Explica a dónde salió el recordatorio.';

-- =============================================================================
-- 202609280003_citas_vistas.sql
-- =============================================================================

-- Una cita que baja de Calendar entra sola, sin que nadie del equipo toque
-- nada. La campana necesita saber cuáles ya vio alguien para poder dejar de
-- mostrarlas, igual que una derivación se marca como atendida.
--
-- Nace en `true` y recién después pasa a `false` por omisión: así las citas que
-- ya existen quedan como vistas y la campana no arranca con meses de reservas
-- viejas encima. Las nuevas entran sin ver, que es lo que se quiere.
alter table public.appointments
  add column if not exists vista boolean not null default true;

alter table public.appointments
  alter column vista set default false;

comment on column public.appointments.vista is
  'Si alguien del equipo ya vio esta cita en la campana.';

-- La campana la consulta en cada carga del panel: sin índice es un scan de
-- toda la tabla, y las no vistas son siempre un puñado.
create index if not exists appointments_sin_ver_idx
  on public.appointments (workspace_id, start_time)
  where vista = false;

-- =============================================================================
-- 202609300001_enlace_de_la_cita.sql
-- =============================================================================

-- El enlace de una cita deja de ser sólo el de Calendar.
--
-- `calendar_link` nació para guardar el `hangoutLink` o el `htmlLink` que baja
-- por el webhook, y es lo que sale en el hueco `{link}` de los recordatorios.
-- Una cita cargada a mano en el CRM no baja de ningún lado: hasta acá ese hueco
-- salía sin dato en todos los recordatorios de las citas que carga el equipo,
-- que son las que más lo necesitan —el Meet o el Zoom lo arma el vendedor—.
--
-- No hace falta columna nueva: es el mismo dato con dos orígenes, y partirlo en
-- dos obligaría a todo lector a preguntarse cuál mira. Lo único que cambia es
-- quién lo escribe, y eso ya lo dice `origen`.
--
-- Idempotente: se puede correr dos veces sin romper nada.

comment on column public.appointments.calendar_link is
  'Enlace de la cita: el de Calendar cuando baja del webhook, o el que se carga a mano en el CRM. Es el que sale en el hueco {link} de los recordatorios.';

-- =============================================================================
-- 202610010001_horario_del_agente.sql
-- =============================================================================

-- El horario en el que contesta cada agente.
--
-- Hasta acá el agente era de dos estados: prendido —y entonces contestaba a
-- cualquier hora de cualquier día— o apagado. Para un equipo que atiende de 9 a
-- 18 eso deja dos agujeros. El de la madrugada es el que se ve: el lead que
-- escribe a las 3 AM recibe una respuesta redactada al instante, y si en esa
-- charla el agente quedó en que "un asesor te escribe en un rato", el asesor
-- aparece seis horas después. El otro es el que molesta de verdad: el agente
-- coordina reuniones y promete respuestas de gente que no está, así que a la
-- mañana alguien tiene que salir a desdecirlo.
--
-- Fuera del horario el agente no contesta: el mensaje queda en la bandeja y lo
-- atiende una persona cuando abre. No se guarda para contestarlo más tarde a
-- propósito, porque la respuesta sale en el `after()` del webhook y ahí no hay
-- dónde esperar ocho horas (ver `MAX_REPLY_DELAY_SECONDS`).
--
-- Son las mismas tres piezas que ya deciden los turnos del reparto y la franja
-- de envío de las automatizaciones —días, hora de apertura, hora de cierre, en
-- la zona del workspace— y por eso se escriben igual: minutos desde la
-- medianoche y 0 = domingo. Una pieza más con otra convención sería una tercera
-- forma de escribir lo mismo.
--
-- Idempotente: se puede correr dos veces sin romper nada.

alter table public.ai_agent_configs
  -- Días en que contesta, 0 = domingo, igual que `Date.getDay()`.
  --
  -- Nace con los siete puestos: correr esto no cambia el comportamiento de
  -- ningún workspace, que es lo que tiene que pasar con una migración que
  -- agrega un recorte que todavía nadie configuró.
  add column if not exists dias smallint[] not null default '{0,1,2,3,4,5,6}',
  -- Minutos desde la medianoche. [0, 1440) es el día completo, y es el default:
  -- el fin es exclusivo, igual que en la franja de las automatizaciones.
  add column if not exists hora_desde smallint not null default 0,
  add column if not exists hora_hasta smallint not null default 1440;

alter table public.ai_agent_configs
  drop constraint if exists ai_agent_configs_hora_desde_check,
  drop constraint if exists ai_agent_configs_hora_hasta_check,
  drop constraint if exists ai_agent_configs_dias_check;

-- `hora_desde` no llega a 1440 porque empezar a la medianoche siguiente sería
-- una franja vacía, que no significa nada. `hora_hasta` sí: es el cierre
-- exclusivo del día completo.
alter table public.ai_agent_configs
  add constraint ai_agent_configs_hora_desde_check check (hora_desde between 0 and 1439),
  add constraint ai_agent_configs_hora_hasta_check check (hora_hasta between 0 and 1440),
  -- Un día que no es un día de la semana dejaría al agente callado un día
  -- entero sin que nada lo explique. El arreglo vacío sí se permite: se lee
  -- como "todos los días", la misma convención que `ai_agent_pipelines` —no
  -- elegir es no restringir— y la lectura segura para un recorte que, mal
  -- interpretado, enmudece al agente sin aviso.
  add constraint ai_agent_configs_dias_check check (
    dias <@ '{0,1,2,3,4,5,6}'::smallint[] and array_position(dias, null) is null
  );

comment on column public.ai_agent_configs.dias is
  'Días en que el agente contesta, 0 = domingo. Vacío es todos.';
comment on column public.ai_agent_configs.hora_desde is
  'Minutos desde la medianoche en que abre, en la zona del workspace.';
comment on column public.ai_agent_configs.hora_hasta is
  'Minutos desde la medianoche en que cierra, exclusivo. Invertido o igual a hora_desde es todo el día.';

-- =============================================================================
-- 202610010002_aviso_fuera_de_horario.sql
-- =============================================================================

-- El aviso que sale cuando el agente está fuera de horario.
--
-- Con el horario solo, el lead que escribe a las 3 AM no recibe nada. Para el
-- equipo eso es correcto —el mensaje queda en la bandeja y se atiende al abrir—
-- pero del otro lado el silencio no se distingue de un número que no existe, y
-- quien no sabe si lo leyeron escribe de nuevo, o se va a la competencia.
--
-- Es un texto fijo y no una respuesta del modelo a propósito. Fuera de horario
-- lo único honesto que se puede decir es cuándo se atiende: un modelo pensando
-- a esa hora vuelve a lo de antes —coordina reuniones y promete respuestas de
-- gente que no está— con el agravante de que ahora nadie va a leer ese chat
-- hasta la mañana. Y cuesta tokens para decir una sola frase.
--
-- Nace vacío, que es apagado: quien no lo cargue sigue con el silencio de
-- antes. Así correr esto no cambia el comportamiento de ningún workspace.
--
-- Idempotente: se puede correr dos veces sin romper nada.

alter table public.ai_agent_configs
  add column if not exists aviso_fuera_de_horario text not null default '';

alter table public.ai_agent_configs
  drop constraint if exists ai_agent_configs_aviso_check;

-- El tope es de cortesía, no de la base: lo que sale fuera de horario es una o
-- dos frases diciendo cuándo se atiende. Un texto más largo que eso es un
-- discurso que nadie escribió para leer a las 3 AM, y lo que necesita es el
-- agente, que a esa hora justamente no está contestando.
alter table public.ai_agent_configs
  add constraint ai_agent_configs_aviso_check
  check (char_length(aviso_fuera_de_horario) <= 300);

comment on column public.ai_agent_configs.aviso_fuera_de_horario is
  'Texto que se manda cuando llega un mensaje fuera del horario del agente. Vacío es no mandar nada.';

-- =============================================================================
-- 202610010003_horario_cortado.sql
-- =============================================================================

-- El horario del agente pasa a ser una lista de franjas.
--
-- Nació como un solo par de horas, y eso no alcanza para el horario cortado:
-- un negocio que atiende de 9 a 13 y de 16 a 20 tenía que cargar 9 a 20, y el
-- agente contestaba en la siesta —cuando no hay nadie para seguir la charla que
-- él arranca, que es justo el problema que el horario venía a resolver—. La otra
-- salida era dejarlo todo el día, que es todavía peor.
--
-- Lista y no un segundo par de columnas porque "dos" es tan arbitrario como
-- "una": el que atiende corrido necesita una, el que corta al mediodía dos, y
-- con la lista los dos casos son el mismo código. El tope de tres lo pone la
-- app, no la base: alcanza para mañana, tarde y una guardia suelta.
--
-- jsonb y no una tabla aparte por lo mismo que `automations.pasos`: son dos o
-- tres pares de números que siempre se leen juntos con la config, nunca por
-- separado, y una tabla con su RLS para eso es una junta más en cada mensaje que
-- entra. La forma de cada franja la valida la app (`errorDeHorario`), igual que
-- la de los pasos.
--
-- Lo que ya estaba cargado se conserva: el par de horas se convierte en la
-- primera franja. Un horario de día completo no deja franja ninguna, porque la
-- lista vacía es exactamente eso: contestar a toda hora.
--
-- Idempotente: se puede correr dos veces sin romper nada.

alter table public.ai_agent_configs
  add column if not exists franjas jsonb not null default '[]'::jsonb;

-- La conversión corre sólo si las columnas viejas todavía están, así que esto
-- sirve igual en una base recién creada y en una que venía con horario cargado.
-- El `franjas = '[]'` del final es lo que lo hace repetible: una vez convertido,
-- una segunda corrida no pisa lo que se haya configurado después.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'ai_agent_configs'
      and column_name = 'hora_desde'
  ) then
    update public.ai_agent_configs
    set franjas = jsonb_build_array(jsonb_build_object('desde', hora_desde, 'hasta', hora_hasta))
    where hora_desde < hora_hasta
      and not (hora_desde <= 0 and hora_hasta >= 1440)
      and franjas = '[]'::jsonb;
  end if;
end $$;

alter table public.ai_agent_configs
  drop constraint if exists ai_agent_configs_hora_desde_check,
  drop constraint if exists ai_agent_configs_hora_hasta_check;

alter table public.ai_agent_configs
  drop column if exists hora_desde,
  drop column if exists hora_hasta;

alter table public.ai_agent_configs
  drop constraint if exists ai_agent_configs_franjas_check;

-- El check cuida la forma gruesa —que sea una lista y que no crezca sin fin
-- desde el navegador— y no el contenido de cada franja. Lo fino lo valida la
-- app, que es la que puede explicar en una frase por qué una franja que cruza
-- la medianoche no se guarda.
alter table public.ai_agent_configs
  add constraint ai_agent_configs_franjas_check check (
    jsonb_typeof(franjas) = 'array' and jsonb_array_length(franjas) <= 3
  );

comment on column public.ai_agent_configs.franjas is
  'Franjas en que el agente contesta, [{"desde":540,"hasta":780},...] en minutos desde la medianoche. Vacío es todo el día.';

-- =============================================================================
-- 202610010004_horario_que_excluye.sql
-- =============================================================================

-- El horario del agente puede decir "contesta acá" o "no contesta acá".
--
-- Las franjas nacieron como lista blanca: el agente contesta adentro y calla
-- afuera. Sirve para el negocio que atiende de 9 a 18, pero un agente de IA casi
-- siempre arranca al revés —contesta siempre— y lo que se quiere declarar es la
-- excepción: "menos de 13 a 16", "menos los domingos".
--
-- Con una sola lectura, esa excepción obliga a cargar el complemento: para no
-- contestar de 13 a 16 había que escribir dos franjas, de 00 a 13 y de 16 a 24.
-- Es la forma más fácil de equivocarse —un minuto de más en el borde y el agente
-- queda hablando justo cuando no tiene que hablar— y encima no se lee: nadie
-- reconoce "de 00:00 a 13:00 y de 16:00 a 24:00" como "cerramos al mediodía".
--
-- El interruptor son las mismas franjas leídas al revés, así que no agrega
-- ningún campo para cargar: lo que cambia es si lo marcado es cuándo contesta o
-- cuándo no.
--
-- Arranca en false, que es la lista blanca de siempre: correr esto no cambia el
-- comportamiento de ningún workspace.
--
-- Idempotente: se puede correr dos veces sin romper nada.

alter table public.ai_agent_configs
  add column if not exists horario_excluye boolean not null default false;

comment on column public.ai_agent_configs.horario_excluye is
  'false: las franjas son cuándo contesta. true: son cuándo NO contesta y el resto del tiempo sí.';

-- =============================================================================
-- 202610020001_chats_destacados.sql
-- =============================================================================

-- Chats destacados.
--
-- La lista de la bandeja ordena por actividad: el chat que importa toda la
-- semana se hunde cada vez que escribe cualquier otro, y había que buscarlo por
-- nombre una y otra vez. La estrella lo fija arriba.
--
-- La marca es del workspace y no de cada persona: en un equipo chico el chat
-- importante es el mismo para todos, y una tabla aparte por usuario es más de
-- lo que esto necesita.
alter table public.conversations
  add column if not exists destacada boolean not null default false;

comment on column public.conversations.destacada is
  'Chat fijado arriba en la bandeja con una estrella.';

-- La bandeja trae sólo las 50 más recientes: sin este índice el orden por
-- estrella obliga a recorrer todas las conversaciones del workspace.
create index if not exists conversations_destacadas_idx
  on public.conversations (workspace_id, destacada desc, updated_at desc);

-- =============================================================================
-- 202610030001_movimientos_del_agente.sql
-- =============================================================================

-- El agente mueve la tarjeta de columna, con el criterio escrito por el usuario.
--
-- Hasta acá mover de etapa era de las automatizaciones (el paso `mover`) y de
-- la mano que arrastra la tarjeta. Las dos son reglas duras: entró en esta
-- columna, pasaron tantas horas. Lo que ninguna puede es leer la conversación y
-- decidir, que es justo lo que el agente ya está haciendo para contestar.
--
-- La regla no se escribe en código porque el criterio es del negocio, no del
-- CRM: "cuando ya dijo su rubro y cuántos vendedores tiene" sólo lo sabe quien
-- vende. Por eso el criterio es texto libre y viaja al modelo tal cual.
--
-- Nace vacía: crear la tabla no mueve ninguna tarjeta. El agente recién empieza
-- a mover cuando alguien carga la primera regla desde el panel y la guarda.
--
-- Idempotente: se puede correr dos veces sin romper nada.

-- Tabla y no un arreglo en `tools_config`, por lo mismo que `ai_agent_pipelines`:
-- con la clave foránea, borrar una columna del embudo se lleva la regla que la
-- apuntaba. Con un arreglo quedaría un id muerto y el agente intentando mover a
-- una etapa que ya no existe, que es la clase de error que no se ve hasta que
-- alguien revisa por qué una tarjeta nunca se movió.
create table if not exists public.ai_agent_stage_moves (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  config_id uuid not null references public.ai_agent_configs(id) on delete cascade,

  -- A qué columna mueve.
  stage_id uuid not null references public.pipeline_stages(id) on delete cascade,

  -- Desde cuál. Null es "desde cualquiera".
  --
  -- Es la columna que evita que una regla se cumpla para siempre. "Ya dijo su
  -- rubro" sigue siendo verdad tres días después: sin el desde, la regla que
  -- lleva a Calificado seguiría pidiendo volver a Calificado cuando el lead ya
  -- está en Visita coordinada, y la tarjeta quedaría yendo y viniendo.
  desde_stage_id uuid references public.pipeline_stages(id) on delete cascade,

  -- El criterio, en castellano, como lo escribió quien configura.
  --
  -- El tope de 300 no lo pide Postgres: el criterio viaja al modelo en cada
  -- clasificación, y uno de tres renglones no decide mejor que uno de uno. El
  -- piso de 3 es para que no se guarde un criterio vacío de hecho, que el modelo
  -- leería como "moveme siempre".
  criterio text not null check (length(trim(criterio)) between 3 and 300),

  activo boolean not null default true,
  created_at timestamptz not null default now(),

  -- Una sola regla por par (desde, hacia) en cada agente. `nulls not distinct`
  -- porque sin eso dos reglas "desde cualquiera" hacia la misma columna no
  -- chocarían —en Postgres dos nulls son distintos— y el modelo recibiría dos
  -- criterios contradictorios para el mismo movimiento.
  unique nulls not distinct (config_id, stage_id, desde_stage_id)
);

create index if not exists ai_agent_stage_moves_workspace_idx
  on public.ai_agent_stage_moves (workspace_id);

create index if not exists ai_agent_stage_moves_config_idx
  on public.ai_agent_stage_moves (config_id);

comment on table public.ai_agent_stage_moves is
  'Reglas con las que el agente mueve de columna. Sin filas, no mueve nada.';
comment on column public.ai_agent_stage_moves.desde_stage_id is
  'Etapa desde la que aplica la regla. Null: desde cualquiera.';
comment on column public.ai_agent_stage_moves.criterio is
  'Cuándo mover, en castellano. Viaja al modelo tal cual.';

-- Las tres cosas que una regla no puede ser, y por qué van en la base.
--
-- Un check normal no alcanza: las tres miran otra tabla. Y la UI no alcanza
-- tampoco, porque el caso que importa aparece después de guardar: alguien
-- renombra "Propuesta" a "Cerrado" y le pone kind 'won'. Sin esto, una regla
-- que era legítima se convierte sola en un cierre de venta automático. Con
-- esto, el día que se intente escribir eso falla y hay que decidirlo a mano.
-- `search_path = ''` igual que el resto de las funciones del esquema: obliga a
-- escribir `public.` en todo y así un esquema puesto adelante por quien llama no
-- puede hacer que la validación lea otra tabla.
create or replace function public.ai_agent_stage_move_valida()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  destino record;
  origen record;
begin
  select workspace_id, kind, pipeline_id into destino
  from public.pipeline_stages where id = new.stage_id;

  if not found or destino.workspace_id <> new.workspace_id then
    raise exception 'La etapa de destino no pertenece a este workspace.';
  end if;

  -- Ganado y Perdido quedan afuera. De ahí cuelgan las métricas y la conversión
  -- de Meta: un cierre que el agente inventó ensucia los dos, y no se arregla
  -- moviendo la tarjeta para atrás.
  if destino.kind <> 'open' then
    raise exception 'El agente no puede mover a una etapa de tipo %. Sólo a columnas abiertas.', destino.kind;
  end if;

  if new.desde_stage_id is not null then
    if new.desde_stage_id = new.stage_id then
      raise exception 'La etapa de origen y la de destino no pueden ser la misma.';
    end if;

    select workspace_id, pipeline_id into origen
    from public.pipeline_stages where id = new.desde_stage_id;

    if not found or origen.workspace_id <> new.workspace_id then
      raise exception 'La etapa de origen no pertenece a este workspace.';
    end if;

    -- Mover entre embudos distintos no es mover: es sacar la tarjeta de un
    -- tablero y ponerla en otro, con otras métricas y otro equipo mirándola.
    if origen.pipeline_id <> destino.pipeline_id then
      raise exception 'Las dos etapas tienen que ser del mismo embudo.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists ai_agent_stage_moves_valida on public.ai_agent_stage_moves;
create trigger ai_agent_stage_moves_valida
  before insert or update on public.ai_agent_stage_moves
  for each row execute function public.ai_agent_stage_move_valida();

alter table public.ai_agent_stage_moves enable row level security;

-- Leer, cualquier miembro: el motivo de cada movimiento aparece en el chat y
-- quien atiende tiene que poder ver qué regla lo explica.
drop policy if exists "members read agent stage moves" on public.ai_agent_stage_moves;
create policy "members read agent stage moves" on public.ai_agent_stage_moves
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

-- Escribir queda para quien puede tocar los agentes, igual que el resto de su
-- configuración: es la misma decisión repartida en tres tablas.
drop policy if exists "agent managers write agent stage moves" on public.ai_agent_stage_moves;
create policy "agent managers write agent stage moves" on public.ai_agent_stage_moves
  for all to authenticated
  using (public.has_permission(workspace_id, 'gestionar_agentes'))
  with check (public.has_permission(workspace_id, 'gestionar_agentes'));

-- =============================================================================
-- 202610070001_tareas.sql
-- =============================================================================

-- Tareas: cada integrante del equipo programa lo que tiene que hacer.
--
-- "Llamar a Juan mañana a las 10", "mandar la propuesta el jueves". Hasta acá
-- eso vivía en la cabeza de cada uno o en una nota del celular, y el CRM sólo
-- sabía de citas, que son otra cosa: una cita es con el cliente y tiene hora de
-- las dos partes; una tarea es trabajo de alguien del equipo y la hora la pone
-- él.
--
-- Tres reglas definen la tabla:
--
--   - Cualquiera se programa tareas a sí mismo, sin permiso especial. Es la
--     razón de existir del módulo.
--   - Darle una tarea a otra persona es el permiso `asignar_tareas`.
--   - Ver las tareas de los demás es el permiso `ver_tareas_del_equipo`.
--     El administrador tiene los dos por rol, como todos los permisos.
--
-- El lead es opcional: "preparar el reporte del mes" también es una tarea.
--
-- Idempotente: se puede correr dos veces sin romper nada.

create table if not exists public.tareas (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  titulo text not null check (length(trim(titulo)) between 1 and 200),
  notas text check (notas is null or length(notas) <= 2000),

  -- Texto con check y no un enum de Postgres, igual que `appointments.tipo`:
  -- agregar un valor a un enum no se puede deshacer dentro de una transacción.
  tipo text not null default 'seguimiento'
    check (tipo in ('llamada', 'mensaje', 'seguimiento', 'reunion', 'otro')),

  -- Para cuándo es.
  vence_at timestamptz not null,

  -- Cuándo avisar, ya calculado. Null es "sin aviso".
  --
  -- Se guarda el instante y no "15 minutos antes" para que el barrido del
  -- reloj sea una comparación contra `now()` y nada más.
  aviso_at timestamptz,

  -- Cuándo salió el aviso. Es la reserva que impide que dos vueltas del reloj
  -- avisen dos veces la misma tarea: se marca antes de mandar.
  avisada_at timestamptz,

  -- Quién la tiene que hacer y quién la creó. Sin `not null`: si la cuenta de
  -- alguien se borra, la tarea queda sin responsable en vez de desaparecer, y
  -- un administrador la reparte.
  asignada_a uuid references auth.users(id) on delete set null,
  creada_por uuid references auth.users(id) on delete set null,

  -- El lead al que corresponde, si corresponde a alguno. Borrar el contacto se
  -- lleva sus tareas, igual que se lleva sus citas.
  contact_id uuid references public.contacts(id) on delete cascade,

  estado text not null default 'pendiente'
    check (estado in ('pendiente', 'hecha', 'cancelada')),
  completada_at timestamptz,

  -- Si quien la recibió ya la vio. Sólo importa cuando la creó otra persona:
  -- es lo que la campana muestra como "te pasaron una tarea".
  vista boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- La lista de cada uno: lo pendiente, por fecha.
create index if not exists tareas_pendientes_idx
  on public.tareas (workspace_id, asignada_a, vence_at)
  where estado = 'pendiente';

-- Las tareas de un lead, para su ficha.
create index if not exists tareas_contacto_idx
  on public.tareas (contact_id)
  where contact_id is not null;

-- Lo que mira el reloj en cada vuelta: avisos vencidos que todavía no salieron.
create index if not exists tareas_avisos_idx
  on public.tareas (aviso_at)
  where estado = 'pendiente' and avisada_at is null and aviso_at is not null;

-- Lo que mira la campana. Las no vistas son siempre un puñado.
create index if not exists tareas_sin_ver_idx
  on public.tareas (workspace_id, asignada_a)
  where vista = false;

drop trigger if exists tareas_touch_updated_at on public.tareas;
create trigger tareas_touch_updated_at
  before update on public.tareas
  for each row execute function public.touch_updated_at();

comment on table public.tareas is
  'Trabajo programado de cada integrante del equipo, con o sin lead.';
comment on column public.tareas.aviso_at is
  'Cuándo avisar a quien la tiene asignada. Null: sin aviso.';
comment on column public.tareas.avisada_at is
  'Cuándo salió el aviso. Se marca antes de mandar, para no avisar dos veces.';
comment on column public.tareas.vista is
  'false si se la asignó otra persona y quien la recibió todavía no la vio.';

-- ---------------------------------------------------------------------------
-- Quién ve una tarea
--
-- `security definer` por lo mismo que las funciones de permisos: se la llama
-- desde la política y lee workspace_members y contacts sin volver a pasar por
-- RLS.
--
-- Quien la tiene asignada y quien la creó la ven siempre, aunque el lead ya no
-- sea suyo: la tarea es de ellos. El resto del equipo —el administrador o quien
-- tenga `ver_tareas_del_equipo`— la ve si además ve el lead, porque el título de
-- una tarea suele llevar el nombre del cliente, y ver la tarea no puede ser una
-- forma de enterarse de leads que no te tocan.
-- ---------------------------------------------------------------------------

create or replace function public.puede_ver_tarea(
  target_workspace uuid,
  asignada uuid,
  creador uuid,
  contacto uuid
)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = target_workspace
      and m.user_id = auth.uid()
      and (
        asignada = auth.uid()
        or creador = auth.uid()
        or (
          (m.role in ('owner', 'admin')
           or coalesce((m.permissions ->> 'ver_tareas_del_equipo')::boolean, false))
          and (contacto is null or public.can_see_contact_row(contacto))
        )
      )
  );
$$;

grant execute on function public.puede_ver_tarea(uuid, uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Si un miembro puede ver un lead, para cualquier miembro y no sólo para quien
-- está en sesión.
--
-- Es `can_see_contact` con el usuario como parámetro. Lo necesita la guarda de
-- abajo: al darle a alguien una tarea sobre un lead hay que saber si *esa
-- persona* ve el lead, no quien la está creando.
--
-- No se le da a `authenticated`: preguntar qué ve otra persona no es algo que
-- la app necesite exponer. Sólo la usa el trigger, que corre como su dueño.
-- ---------------------------------------------------------------------------

create or replace function public.miembro_ve_contacto(
  target_workspace uuid,
  miembro uuid,
  target_contact uuid
)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.workspace_members m
    join public.contacts c on c.id = target_contact and c.workspace_id = m.workspace_id
    where m.workspace_id = target_workspace
      and m.user_id = miembro
      and (
        m.role in ('owner', 'admin')
        or coalesce((m.permissions ->> 'ver_todos_los_leads')::boolean, false)
        or c.assigned_to = miembro
        or (c.assigned_to is null
            and coalesce((m.permissions ->> 'ver_leads_sin_asignar')::boolean, false))
      )
  );
$$;

revoke execute on function public.miembro_ve_contacto(uuid, uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- La guarda de la tabla
--
-- Las políticas miran la fila nueva y la vieja por separado; lo que sigue
-- necesita compararlas, o mirar otras tablas, y por eso va en un trigger:
--
--   - El workspace y quien la creó no cambian nunca.
--   - Pasarle la tarea a otra persona pide `asignar_tareas`. Quedártela vos no.
--   - Quien la recibe tiene que ser del workspace y, si hay lead, verlo: una
--     tarea sobre un cliente que no podés abrir es una tarea que no podés
--     hacer.
--   - Al cambiar de manos queda sin ver, para que la campana avise.
--   - Al cambiar el aviso, vuelve a quedar pendiente de salir.
--   - `completada_at` sigue al estado solo.
--
-- `auth.uid()` es null en los trabajos de servidor (el reloj entra con la
-- clave de servicio). Ahí no hay sesión que controlar y los permisos no
-- aplican; las reglas de consistencia sí.
-- ---------------------------------------------------------------------------

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
      raise exception 'No tenés permiso para darle tareas a otra persona.';
    end if;

    if not exists (
      select 1 from public.workspace_members m
      where m.workspace_id = new.workspace_id and m.user_id = new.asignada_a
    ) then
      raise exception 'Esa persona no es parte del equipo.';
    end if;

    if new.contact_id is not null
       and not public.miembro_ve_contacto(new.workspace_id, new.asignada_a, new.contact_id) then
      raise exception 'Esa persona no ve este lead. Asignale el lead primero o elegí a otra persona.';
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

drop trigger if exists tareas_guard on public.tareas;
create trigger tareas_guard
  before insert or update on public.tareas
  for each row execute function public.guard_tarea();

-- ---------------------------------------------------------------------------
-- Políticas
-- ---------------------------------------------------------------------------

alter table public.tareas enable row level security;

drop policy if exists "read visible tareas" on public.tareas;
create policy "read visible tareas" on public.tareas
  for select to authenticated
  using (public.puede_ver_tarea(workspace_id, asignada_a, creada_por, contact_id));

-- Crear: siempre a nombre propio. A quién se le da lo controla la guarda.
drop policy if exists "create own tareas" on public.tareas;
create policy "create own tareas" on public.tareas
  for insert to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and creada_por = auth.uid()
    and (contact_id is null or public.can_see_contact_row(contact_id))
  );

-- Editar: quien la tiene, quien la creó o un administrador. Ver las del equipo
-- no alcanza para tocarlas: es un permiso de mirar.
drop policy if exists "update own tareas" on public.tareas;
create policy "update own tareas" on public.tareas
  for update to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and (
      asignada_a = auth.uid()
      or creada_por = auth.uid()
      or public.is_workspace_admin(workspace_id)
    )
  )
  with check (public.is_workspace_member(workspace_id));

-- Borrar: quien la creó o un administrador. Quien sólo la recibió la cancela.
drop policy if exists "delete own tareas" on public.tareas;
create policy "delete own tareas" on public.tareas
  for delete to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and (creada_por = auth.uid() or public.is_workspace_admin(workspace_id))
  );

-- =============================================================================
-- 202610080001_leads_por_canal.sql
-- =============================================================================

-- Por qué canal llegan los leads, para la torta del Resumen.
--
-- No hay una columna que lo diga: el contacto se crea en cinco lugares —el
-- webhook de cada proveedor, la landing, la reserva de Calendar, el alta a mano
-- y la importación— y ninguno anota de dónde vino. Se deduce de lo que dejó
-- cada uno, y por eso se puede contar también lo que entró antes de esta
-- migración.
--
-- Va en una función aparte y no dentro de `metricas_resumen` porque aquélla
-- devuelve una fila y esto es una fila por canal. Mismo criterio que allá: no
-- se cuenta sobre las filas paginadas del tablero sino en Postgres, y corre con
-- las políticas de quien la llama.
--
-- Idempotente: se puede correr dos veces sin romper nada.

-- El índice que usa el primer mensaje de cada chat ya existe:
-- `(conversation_id, created_at)`, el mismo que pinta un chat.

-- ---------------------------------------------------------------------------
-- Cómo se decide el canal de un lead
--
-- Se mira con qué empezó todo, en este orden:
--
-- 1. Escribió por un chat y eso lo dio de alta. El webhook crea el contacto al
--    recibir el mensaje, y el mensaje se guarda con la hora en que lo mandó la
--    persona, así que llega con fecha anterior al alta. Es el caso común.
-- 2. Lleva la etiqueta `web`: lo creó la charla de la landing. Va antes que la
--    regla de abajo porque la landing tiene un "Seguir por WhatsApp", y quien lo
--    toca escribe un minuto después de que la charla lo dio de alta. Ése llegó
--    por la web, aunque el primer mensaje sea de WhatsApp.
-- 3. Reservó en Calendar: la cita y el contacto nacieron juntos.
-- 4. Escribió apenas después del alta. Es el margen para los relojes de los
--    proveedores, que no siempre coinciden al segundo con el de la base.
-- 5. Todo lo demás es carga manual: el alta a mano, la importación, o un chat
--    que abrió el equipo. Si quien escribió primero fue el equipo, la persona no
--    llegó: la fueron a buscar.
--
-- Mirar sólo el primer mensaje del contacto, sin compararlo con el alta, se
-- equivocaba con los cargados a mano: alguien importado en marzo que contesta
-- una difusión en junio no llegó por WhatsApp.
-- ---------------------------------------------------------------------------
create or replace function public.leads_por_canal(
  p_workspace uuid,
  p_desde timestamptz,
  p_hasta timestamptz
)
returns table (
  canal text,
  total bigint,
  del_tramo bigint
)
language sql stable security invoker set search_path = public as $$
with
activos as (
  select id, created_at, tags from public.contacts
  where workspace_id = p_workspace and archived_at is null
),
-- El primer mensaje de cada contacto, mirando todos sus chats: si escribió por
-- Instagram y un mes después por WhatsApp, llegó por Instagram.
primeros as (
  select distinct on (v.contact_id)
    v.contact_id,
    v.channel::text as canal,
    m.sender_type,
    m.created_at
  from public.conversations v
  join activos c on c.id = v.contact_id
  cross join lateral (
    select sender_type, created_at from public.messages
    where conversation_id = v.id
    order by created_at
    limit 1
  ) m
  where v.workspace_id = p_workspace
  order by v.contact_id, m.created_at
),
origenes as (
  select
    c.created_at,
    case
      when p.sender_type = 'contact' and p.created_at <= c.created_at then p.canal
      when 'web' = any(c.tags) then 'web'
      when exists (
        select 1 from public.appointments a
        where a.contact_id = c.id
          and a.origen = 'calendar'
          and a.created_at <= c.created_at + interval '2 minutes'
      ) then 'calendar'
      when p.sender_type = 'contact'
        and p.created_at <= c.created_at + interval '2 minutes' then p.canal
      else 'manual'
    end as canal
  from activos c
  left join primeros p on p.contact_id = c.id
)
-- El tramo es el mismo de "Leads nuevos": los que se dieron de alta en el mes.
-- Así la torta del mes suma exactamente lo que dice esa tarjeta.
select
  canal,
  count(*),
  count(*) filter (where created_at >= p_desde and created_at < p_hasta)
from origenes
group by canal;
$$;

grant execute on function public.leads_por_canal(uuid, timestamptz, timestamptz) to authenticated;

-- =============================================================================
-- 202610160001_integraciones.sql
-- =============================================================================

-- Las credenciales de los proveedores (OpenAI, YCloud y Zernio), cargadas desde
-- Configuración → Conexiones en vez de las variables de entorno de Vercel.
--
-- `config` guarda lo que no es secreto y se puede mostrar (la URL base, el
-- número propio). `secretos` es un JSON cifrado con AES-256-GCM en el servidor,
-- con una clave que vive en el entorno (INTEGRATIONS_ENCRYPTION_KEY): la base
-- nunca ve una API key en claro, así que un volcado de la base no alcanza para
-- usarlas.
--
-- Una fila por proveedor: cada instalación tiene un solo workspace.
--
-- Sin políticas a propósito: sólo la service role lee y escribe. El panel pasa
-- por Server Actions que nunca devuelven el secreto, sólo si está cargado.
create table if not exists public.integraciones (
  provider text primary key
    check (provider in ('openai', 'ycloud', 'zernio')),
  config jsonb not null default '{}'::jsonb,
  secretos text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

alter table public.integraciones enable row level security;

drop trigger if exists integraciones_touch_updated_at on public.integraciones;
create trigger integraciones_touch_updated_at
  before update on public.integraciones
  for each row execute function public.touch_updated_at();

-- =============================================================================
-- 202611230001_pedidos.sql
-- =============================================================================

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

-- =============================================================================
-- 202611250001_hora_de_lima_y_mensajes.sql
-- =============================================================================

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

-- =============================================================================
-- 202611260001_orden_por_codigo.sql
-- =============================================================================

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

-- =============================================================================
-- 202611270001_secciones_por_usuario.sql
-- =============================================================================

-- Qué secciones del CRM ve cada persona.
--
-- `secciones` guarda los nombres tal cual aparecen en el menú ("Pedidos",
-- "Tareas"...). Vacío (null) quiere decir "las de su rol". El administrador
-- siempre ve todo: para él se ignora.
--
-- Esto decide qué se muestra en el menú. Lo que protege los datos siguen
-- siendo las políticas RLS: esconder una sección no le da acceso a nada nuevo
-- a nadie, y mostrarla tampoco.
alter table public.workspace_members
  add column if not exists secciones text[];

create or replace function public.guardar_secciones(ws uuid, usuario uuid, nuevas text[])
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.rol_de_venta(ws) is distinct from 'admin' then
    raise exception 'Solo un administrador puede elegir qué secciones ve cada persona.';
  end if;
  update public.workspace_members set secciones = nuevas
  where workspace_id = ws and user_id = usuario;
  if not found then
    raise exception 'Esa persona no es parte del equipo.';
  end if;
end;
$$;

grant execute on function public.guardar_secciones(uuid, uuid, text[]) to authenticated;

-- =============================================================================
-- 202611280001_shopify.sql
-- =============================================================================

-- Pedidos que llegan solos desde Shopify (tienda y landing de EasySell).
--
-- `shopify_id` es el id del pedido en Shopify: con él un pedido nunca entra dos
-- veces, aunque Shopify reintente el aviso. Los pedidos cargados a mano o de la
-- planilla lo tienen vacío (los vacíos no chocan entre sí).
alter table public.pedidos add column if not exists shopify_id text;

create unique index if not exists pedidos_shopify_id_key
  on public.pedidos (workspace_id, shopify_id);

-- Shopify como una conexión más en Configuración → Conexiones.
alter table public.integraciones drop constraint if exists integraciones_provider_check;
alter table public.integraciones
  add constraint integraciones_provider_check
  check (provider in ('openai', 'ycloud', 'zernio', 'shopify'));

-- =============================================================================
-- 202611290001_recordatorios_y_canal_shopify.sql
-- =============================================================================

-- Próxima llamada con fecha y hora, y un solo canal SHOPIFY.

/* --------------------------------------------- recordatorio de llamada */

-- `prox_llamada` (sólo la fecha) queda por los pedidos de la planilla. Lo nuevo
-- guarda el momento exacto y a quién avisarle: a quien lo programó.
alter table public.pedidos
  add column if not exists prox_llamada_at timestamptz,
  add column if not exists recordatorio_de uuid references auth.users(id) on delete set null,
  add column if not exists recordatorio_visto boolean not null default false;

-- Lo que busca el aviso cada minuto: los míos, vencidos y sin ver.
create index if not exists pedidos_recordatorios_idx
  on public.pedidos (recordatorio_de, prox_llamada_at)
  where not recordatorio_visto;

-- El historial no anota los campos internos del aviso: "Ya llamé" no es un
-- cambio del pedido. La próxima llamada se sigue viendo por `prox_llamada`.
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
      and n.key not in (
        'updated_at', 'ultima_gestion', 'busqueda', 'fecha_estado', 'fecha_primera_gestion',
        'codigo_num', 'recordatorio_de', 'recordatorio_visto', 'prox_llamada_at'
      )
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

/* --------------------------------------------------- canal SHOPIFY */

-- Tienda y landing son el mismo canal. De dónde vino queda en extra, por si
-- algún día hace falta separarlo en la analítica.
update public.pedidos
set extra = extra || jsonb_build_object(
      'SHOPIFY ORIGEN',
      case when canal = 'SHOPIFY LANDING' then 'LANDING' else 'TIENDA' end
    ),
    canal = 'SHOPIFY'
where canal in ('SHOPIFY TIENDA', 'SHOPIFY LANDING');

-- =============================================================================
-- 202611300001_aviso_de_llamadas.sql
-- =============================================================================

-- Aviso push de la próxima llamada, aunque el CRM esté cerrado.
--
-- El reloj (pg_cron, o cualquier servicio que llame a /api/cron/tareas cada
-- minuto) busca las llamadas que vencieron y manda una notificación al
-- celular o la compu de quien la programó. `recordatorio_avisado_at` marca que
-- ya se mandó: así no llega el mismo aviso cada minuto.
alter table public.pedidos add column if not exists recordatorio_avisado_at timestamptz;

create index if not exists pedidos_avisos_pendientes_idx
  on public.pedidos (prox_llamada_at)
  where recordatorio_avisado_at is null and not recordatorio_visto and recordatorio_de is not null;

-- Si la llamada se reprograma, el aviso vuelve a quedar pendiente.
create or replace function public.pedidos_reprogramar_aviso()
returns trigger language plpgsql as $$
begin
  if new.prox_llamada_at is distinct from old.prox_llamada_at then
    new.recordatorio_avisado_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists pedidos_reprogramar_aviso on public.pedidos;
create trigger pedidos_reprogramar_aviso
  before update on public.pedidos
  for each row execute function public.pedidos_reprogramar_aviso();

-- El historial tampoco anota esta marca interna.
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
      and n.key not in (
        'updated_at', 'ultima_gestion', 'busqueda', 'fecha_estado', 'fecha_primera_gestion',
        'codigo_num', 'recordatorio_de', 'recordatorio_visto', 'prox_llamada_at',
        'recordatorio_avisado_at'
      )
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

-- =============================================================================
-- 202612010001_swayp.sql
-- =============================================================================

-- Swayp (motorizado de Lima): la guía de cada pedido y el historial de envíos.

/* ------------------------------------------------------------- la guía */

-- El número de GUÍA que da Swayp. Lo escribe el sistema (al importar, al recibir
-- un aviso o al crear la guía): nadie lo edita a mano.
alter table public.pedidos
  add column if not exists guia_swayp text,
  add column if not exists estado_swayp text;

create index if not exists pedidos_guia_swayp_idx on public.pedidos (workspace_id, guia_swayp);

-- Las guías que vinieron de la planilla (columna GUIA SWAYP).
update public.pedidos
set guia_swayp = nullif(trim(coalesce(extra ->> 'GUIA SWAYP', extra ->> 'GUÍA SWAYP')), '')
where guia_swayp is null
  and nullif(trim(coalesce(extra ->> 'GUIA SWAYP', extra ->> 'GUÍA SWAYP')), '') is not null;

-- Desde la pantalla no se puede tocar: la guía es de Swayp.
create or replace function public.pedidos_proteger_guia()
returns trigger language plpgsql as $$
begin
  if auth.uid() is null or current_setting('crm.importando', true) = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.guia_swayp := null;
    new.estado_swayp := null;
  else
    new.guia_swayp := old.guia_swayp;
    new.estado_swayp := old.estado_swayp;
  end if;
  return new;
end;
$$;

drop trigger if exists pedidos_proteger_guia on public.pedidos;
create trigger pedidos_proteger_guia
  before insert or update on public.pedidos
  for each row execute function public.pedidos_proteger_guia();

/* ------------------------------------------------- historial de envíos */

-- Cada aviso de un courier, tal como llegó. Es la base de la analítica de
-- envíos (entregados, devoluciones, costos) y sirve de prueba ante un reclamo.
create table if not exists public.envio_eventos (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Puede quedar vacío si todavía no se sabe de qué pedido es la guía.
  pedido_id uuid references public.pedidos(id) on delete set null,
  courier text not null default 'SWAYP',
  guia text not null,
  estado_codigo text,
  estado text,
  comentario text,
  -- El id del aviso que manda Swayp: con él un aviso repetido no se guarda dos veces.
  entrega_id text,
  costo numeric(12, 2),
  recaudo numeric(12, 2),
  datos jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists envio_eventos_entrega_key on public.envio_eventos (courier, entrega_id);
create index if not exists envio_eventos_guia_idx on public.envio_eventos (workspace_id, guia, created_at desc);
create index if not exists envio_eventos_pedido_idx on public.envio_eventos (pedido_id, created_at desc);

alter table public.envio_eventos enable row level security;

-- Se ve si se ve el pedido. Los que no tienen pedido, sólo el admin.
drop policy if exists "envio_eventos: ver" on public.envio_eventos;
create policy "envio_eventos: ver" on public.envio_eventos for select to authenticated
  using (
    public.rol_de_venta(workspace_id) = 'admin'
    or exists (select 1 from public.pedidos p where p.id = pedido_id)
  );
-- Sin políticas de escritura: sólo el servidor (los avisos) escribe acá.

/* ------------------------------------------------------- la conexión */

alter table public.integraciones drop constraint if exists integraciones_provider_check;
alter table public.integraciones
  add constraint integraciones_provider_check
  check (provider in ('openai', 'ycloud', 'zernio', 'shopify', 'swayp'));

/* -------------------------------------------- historial sin ruido */

-- El estado de Swayp se ve en su propio historial de envíos; la guía sí se anota.
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
      and n.key not in (
        'updated_at', 'ultima_gestion', 'busqueda', 'fecha_estado', 'fecha_primera_gestion',
        'codigo_num', 'recordatorio_de', 'recordatorio_visto', 'prox_llamada_at',
        'recordatorio_avisado_at', 'estado_swayp'
      )
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

-- =============================================================================
-- 202612020001_pedidos_pendientes.sql
-- =============================================================================

-- Pedidos pendientes: ventas que llegan de afuera (las que cierra la IA en
-- Flujos Inteligentes) y esperan que alguien las revise y las programe.
--
-- No son pedidos todavía: no tienen código WED ni cuentan en nada. Al
-- "Programar", se abre la ficha con los datos ya completados y, al guardar,
-- nace el pedido y la fila queda vinculada a él.

create table if not exists public.pedidos_pendientes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  origen text not null default 'FLUJOS',
  -- El id del pedido en el sistema de origen: con él nunca entra dos veces.
  externo_id text not null,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'programado', 'descartado')),
  cliente text,
  celular text,
  monto numeric(12, 2),
  resumen text,
  -- Los datos ya traducidos a campos del pedido, listos para la ficha.
  propuesta jsonb not null default '{}'::jsonb,
  -- Lo que mandó el origen, completo.
  datos jsonb not null default '{}'::jsonb,
  creado_en_origen timestamptz,
  pedido_id uuid references public.pedidos(id) on delete set null,
  resuelto_por uuid references auth.users(id) on delete set null,
  resuelto_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, origen, externo_id)
);

create index if not exists pedidos_pendientes_estado_idx
  on public.pedidos_pendientes (workspace_id, estado, creado_en_origen desc);

alter table public.pedidos_pendientes enable row level security;

-- Lo ve y lo resuelve cualquiera del equipo con la sección habilitada. Los
-- crea sólo el servidor (la sincronización con Flujos).
drop policy if exists "pedidos_pendientes: ver" on public.pedidos_pendientes;
create policy "pedidos_pendientes: ver" on public.pedidos_pendientes for select to authenticated
  using (public.is_workspace_member(workspace_id));

drop policy if exists "pedidos_pendientes: resolver" on public.pedidos_pendientes;
create policy "pedidos_pendientes: resolver" on public.pedidos_pendientes for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- Hasta dónde se revisó cada origen, para no pedirle todo de nuevo cada vez.
create table if not exists public.sincronizaciones (
  clave text primary key,
  ultima_at timestamptz,
  ultimo_error text,
  updated_at timestamptz not null default now()
);
alter table public.sincronizaciones enable row level security;
-- Sin políticas: sólo el servidor.

-- Flujos como una conexión más.
alter table public.integraciones drop constraint if exists integraciones_provider_check;
alter table public.integraciones
  add constraint integraciones_provider_check
  check (provider in ('openai', 'ycloud', 'zernio', 'shopify', 'swayp', 'flujos'));

-- =============================================================================
-- 202612030001_analitica.sql
-- =============================================================================

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

-- =============================================================================
-- 202612040001_buscar_en_toda_la_base.sql
-- =============================================================================

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

-- =============================================================================
-- 202612050001_tipo_de_pedido.sql
-- =============================================================================

-- Tipo de pedido: VENTA, REPOSICIÓN o CAMBIO.
--
-- Una reposición o un cambio sale del almacén como cualquier pedido (cuenta
-- para el inventario y se despacha igual), pero no es una venta: no le suma a
-- la asesora ni entra en los números de la Analítica. Los pedidos que ya
-- existen quedan como VENTA.

alter table public.pedidos add column if not exists tipo_pedido text not null default 'VENTA';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pedidos_tipo_pedido_valido') then
    alter table public.pedidos add constraint pedidos_tipo_pedido_valido
      check (tipo_pedido in ('VENTA', 'REPOSICIÓN', 'CAMBIO'));
  end if;
end $$;

-- La Analítica, igual que antes pero sólo con las ventas.

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
     where p.workspace_id = ws and not coalesce(p.es_prueba, false) and p.tipo_pedido = 'VENTA'
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
      -- Reposiciones y cambios: salen del almacén, pero no son venta.
      'no_ventas', coalesce((select jsonb_object_agg(x.tipo_pedido, x.n) from
          (select p.tipo_pedido, count(*) as n from pedidos p
            where p.workspace_id = ws and p.tipo_pedido <> 'VENTA' and public.dia_de_lima(p.fecha_creacion) = c.dia
            group by 1) x), '{}'::jsonb),
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
   where workspace_id = ws and not coalesce(es_prueba, false) and tipo_pedido = 'VENTA';

  -- Cómo están hoy los pedidos que se registraron en el rango.
  select coalesce(jsonb_object_agg(x.estado, jsonb_build_object('n', x.n, 'monto', x.monto)), '{}'::jsonb)
    into estados
    from (select estado, count(*) as n, coalesce(sum(monto), 0) as monto
            from pedidos
           where workspace_id = ws and not coalesce(es_prueba, false) and tipo_pedido = 'VENTA'
             and public.dia_de_lima(fecha_creacion) between desde and hasta
           group by estado) x;

  return jsonb_build_object('dias', dias, 'hoy', hoy, 'estados_del_rango', estados);
end;
$$;

-- =============================================================================
-- 202612060001_analitica_solo_equipo.sql
-- =============================================================================

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
