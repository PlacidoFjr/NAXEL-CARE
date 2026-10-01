-- Keep elevated reads behind non-exposed helpers; public RPC wrappers run as the caller.
create schema if not exists naxel_private;
revoke all on schema naxel_private from public, anon;
grant usage on schema naxel_private to authenticated;

create or replace function naxel_private.current_user_org_ids()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select m.organization_id
  from public.org_members as m
  join public.organizations as o on o.id = m.organization_id
  join public.profiles as p on p.id = m.user_id
  where m.user_id = (select auth.uid())
    and m.status = 'Ativo'
    and p.status = 'Ativo'
    and o.status = 'Ativa';
$$;

create or replace function naxel_private.current_user_has_role(p_organization_id text, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.org_members as m
    join public.organizations as o on o.id = m.organization_id
    join public.profiles as p on p.id = m.user_id
    where m.organization_id = p_organization_id
      and m.user_id = (select auth.uid())
      and m.status = 'Ativo'
      and p.status = 'Ativo'
      and o.status = 'Ativa'
      and m.role = any(p_roles)
  );
$$;

revoke all on function naxel_private.current_user_org_ids() from public, anon;
revoke all on function naxel_private.current_user_has_role(text, text[]) from public, anon;
grant execute on function naxel_private.current_user_org_ids() to authenticated;
grant execute on function naxel_private.current_user_has_role(text, text[]) to authenticated;

create or replace function public.current_user_org_ids()
returns setof text
language sql
stable
security invoker
set search_path = ''
as $$
  select naxel_private.current_user_org_ids();
$$;

create or replace function public.current_user_has_role(p_organization_id text, p_roles text[])
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select naxel_private.current_user_has_role(p_organization_id, p_roles);
$$;

revoke all on function public.current_user_org_ids() from public, anon;
revoke all on function public.current_user_has_role(text, text[]) from public, anon;
grant execute on function public.current_user_org_ids() to authenticated;
grant execute on function public.current_user_has_role(text, text[]) to authenticated;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.platform_admins as admin
    where admin.user_id = (select auth.uid())
      and admin.status = 'Ativo'
  );
$$;

revoke all on function public.is_platform_admin() from public, anon;
grant execute on function public.is_platform_admin() to authenticated;
