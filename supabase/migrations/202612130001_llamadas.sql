-- Llamadas: los leads que entran cada día a Flujos, para llamar a los que
-- todavía no se cierran. El servidor los trae de Flujos; la asesora marca
-- 1ra llamada, 2da llamada o NC, y crea la ficha (que queda enlazada).

create table if not exists public.llamadas (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id text not null,
  dia date not null,
  nombre text not null default '',
  celular text,
  producto text,
  etapa text,
  etiquetas jsonb not null default '[]'::jsonb,
  anuncio text,
  creado_en timestamptz,
  llamada text check (llamada in ('PRIMERA', 'SEGUNDA', 'NC')),
  llamada_por uuid,
  llamada_por_alias text,
  llamada_at timestamptz,
  pedido_id uuid references public.pedidos(id) on delete set null,
  actualizado_at timestamptz not null default now(),
  unique (workspace_id, lead_id)
);

create index if not exists llamadas_dia_idx on public.llamadas (workspace_id, dia, creado_en desc);
create index if not exists llamadas_celular_idx on public.llamadas (workspace_id, celular);

alter table public.llamadas enable row level security;
drop policy if exists "llamadas: ver" on public.llamadas;
create policy "llamadas: ver" on public.llamadas for select to authenticated
  using (public.rol_de_venta(workspace_id) is not null);
-- Sin políticas de escritura: el servidor las trae y las funciones las marcan.

-- Los leads de un día con su pedido en la base: el enlazado, o el último del
-- mismo celular de los últimos 30 días (de cualquier asesora, para no llamar
-- a quien ya compró).
create or replace function public.llamadas_del_dia(ws uuid, dia date)
returns table (
  lead_id text, nombre text, celular text, producto text, etapa text, etiquetas jsonb, anuncio text,
  creado_en timestamptz, llamada text, llamada_por_alias text, llamada_at timestamptz,
  pedido_id uuid, pedido_codigo text, pedido_estado text, pedido_asesor text
)
language sql stable security definer set search_path = public as $$
  select l.lead_id, l.nombre, l.celular, l.producto, l.etapa, l.etiquetas, l.anuncio,
         l.creado_en, l.llamada, l.llamada_por_alias, l.llamada_at,
         p.id, p.codigo, p.estado, p.asesor
  from public.llamadas l
  left join lateral (
    select x.id, x.codigo, x.estado, x.asesor
    from public.pedidos x
    where x.workspace_id = ws
      and (x.id = l.pedido_id
           or (l.pedido_id is null and l.celular is not null and x.celular = l.celular
               and x.created_at >= now() - interval '30 days'))
    order by (x.id = l.pedido_id) desc, x.created_at desc
    limit 1
  ) p on true
  where l.workspace_id = ws and l.dia = llamadas_del_dia.dia
    and public.rol_de_venta(ws) is not null
  order by l.creado_en desc;
$$;

-- Marca (o desmarca, con null) la llamada de un lead.
create or replace function public.marcar_llamada(ws uuid, lead text, valor text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.rol_de_venta(ws) is null then
    raise exception 'No eres parte de este equipo.';
  end if;
  if valor is not null and valor not in ('PRIMERA', 'SEGUNDA', 'NC') then
    raise exception 'Llamada no válida.';
  end if;
  update public.llamadas
  set llamada = valor,
      llamada_por = case when valor is null then null else auth.uid() end,
      llamada_por_alias = case when valor is null then null else nullif(public.mi_alias(ws), '') end,
      llamada_at = case when valor is null then null else now() end
  where workspace_id = ws and lead_id = lead;
end;
$$;

-- La ficha creada desde la llamada queda enlazada al lead.
create or replace function public.enlazar_llamada(ws uuid, lead text, pedido uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.rol_de_venta(ws) is null then
    raise exception 'No eres parte de este equipo.';
  end if;
  update public.llamadas set pedido_id = pedido where workspace_id = ws and lead_id = lead;
end;
$$;
