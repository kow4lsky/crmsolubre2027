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
