create table if not exists public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'Ativo' check (status in ('Ativo', 'Suspenso')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

alter table public.platform_admins enable row level security;

revoke all on public.platform_admins from public, anon;
grant select on public.platform_admins to authenticated;

drop policy if exists platform_admin_read_self on public.platform_admins;
create policy platform_admin_read_self on public.platform_admins
  for select to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
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

insert into public.platform_admins (user_id, status)
select id, 'Ativo'
from auth.users
where lower(email) = 'placidojunior34@gmail.com'
on conflict (user_id) do update set status = 'Ativo';
