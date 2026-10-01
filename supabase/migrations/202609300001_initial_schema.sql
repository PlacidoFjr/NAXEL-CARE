-- Naxel Care hosted schema. Intentionally contains no demo or sample records.
-- Apply with Supabase CLI (`supabase db push`) or the SQL editor after review.

create table if not exists public.organizations (
  id text primary key,
  name text not null check (char_length(name) between 1 and 160),
  slug text not null unique check (slug ~ '^[a-z0-9-]{2,80}$'),
  status text not null default 'Ativa' check (status in ('Ativa', 'Suspensa')),
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 160),
  email text not null,
  status text not null default 'Ativo' check (status in ('Ativo', 'Suspenso')),
  created_at timestamptz not null default now()
);

create table if not exists public.org_members (
  organization_id text not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'Técnico' check (role in ('Administrador', 'Gestor', 'Técnico')),
  status text not null default 'Ativo' check (status in ('Ativo', 'Suspenso')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table if not exists public.customers (
  id text not null,
  organization_id text not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 160),
  phone text not null default '',
  email text not null default '',
  city text not null default '',
  type text not null default 'Comercial',
  notes text not null default '',
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  check (char_length(phone) <= 30 and char_length(email) <= 254 and char_length(city) <= 100 and char_length(notes) <= 2000)
);

create table if not exists public.equipment (
  id text not null,
  organization_id text not null references public.organizations(id) on delete cascade,
  customer_id text not null,
  kind text not null,
  brand text not null default '',
  model text not null default '',
  serial text not null default '',
  location text not null default '',
  last_service date,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  foreign key (organization_id, customer_id) references public.customers(organization_id, id) on delete cascade
);

create table if not exists public.service_orders (
  id text not null,
  organization_id text not null references public.organizations(id) on delete cascade,
  customer_id text not null,
  equipment_id text,
  service text not null,
  scheduled_date date not null,
  status text not null default 'Agendado' check (status in ('Agendado', 'Em campo', 'Concluído', 'Cancelado')),
  technician text not null default '',
  value numeric(12,2) not null default 0 check (value >= 0),
  notes text not null default '',
  checklist_json jsonb not null default '[]'::jsonb check (jsonb_typeof(checklist_json) = 'array'),
  photos_json jsonb not null default '[]'::jsonb check (jsonb_typeof(photos_json) = 'array'),
  signature_path text not null default '',
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  foreign key (organization_id, customer_id) references public.customers(organization_id, id),
  foreign key (organization_id, equipment_id) references public.equipment(organization_id, id)
);

create table if not exists public.warranties (
  id text not null,
  organization_id text not null references public.organizations(id) on delete cascade,
  customer_id text not null,
  order_id text not null,
  start_date date not null,
  end_date date not null,
  status text not null default 'Ativa' check (status in ('Ativa', 'Encerrada', 'Cancelada')),
  primary key (organization_id, id),
  foreign key (organization_id, customer_id) references public.customers(organization_id, id),
  foreign key (organization_id, order_id) references public.service_orders(organization_id, id)
);

create table if not exists public.maintenance_returns (
  id text not null,
  organization_id text not null references public.organizations(id) on delete cascade,
  customer_id text not null,
  equipment_id text,
  service text not null,
  due_date date not null,
  estimated_value numeric(12,2) not null default 0 check (estimated_value >= 0),
  status text not null default 'Próximo' check (status in ('Vencido', 'Próximo', 'Convertido', 'Cancelado')),
  source_order_id text,
  primary key (organization_id, id),
  foreign key (organization_id, customer_id) references public.customers(organization_id, id),
  foreign key (organization_id, equipment_id) references public.equipment(organization_id, id),
  foreign key (organization_id, source_order_id) references public.service_orders(organization_id, id)
);

create table if not exists public.reports (
  id text not null,
  organization_id text not null references public.organizations(id) on delete cascade,
  order_id text not null,
  created_at date not null default current_date,
  summary text not null,
  primary key (organization_id, id),
  unique (organization_id, order_id),
  foreign key (organization_id, order_id) references public.service_orders(organization_id, id)
);

create table if not exists public.organization_settings (
  organization_id text primary key references public.organizations(id) on delete cascade,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id text not null,
  organization_id text not null references public.organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity text not null,
  entity_id text not null default '',
  detail_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (organization_id, id)
);

create or replace function public.write_audit_log_for_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  record_data jsonb;
  tenant_id text;
  record_id text;
begin
  record_data := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  tenant_id := record_data ->> 'organization_id';
  record_id := coalesce(record_data ->> 'id', record_data ->> 'organization_id', '');
  insert into public.audit_logs (id, organization_id, user_id, action, entity, entity_id)
  values (
    'aud_' || replace(gen_random_uuid()::text, '-', ''),
    tenant_id,
    (select auth.uid()),
    lower(tg_op),
    tg_table_name,
    record_id
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.write_audit_log_for_row_change() from public, anon, authenticated;

create index if not exists customers_org_name_idx on public.customers(organization_id, name);
create index if not exists equipment_org_customer_idx on public.equipment(organization_id, customer_id);
create index if not exists orders_org_date_idx on public.service_orders(organization_id, scheduled_date desc, created_at desc);
create index if not exists returns_org_due_idx on public.maintenance_returns(organization_id, status, due_date);
create index if not exists warranties_org_end_idx on public.warranties(organization_id, status, end_date);
create index if not exists reports_org_created_idx on public.reports(organization_id, created_at desc);
create index if not exists audit_org_created_idx on public.audit_logs(organization_id, created_at desc);

drop trigger if exists customers_audit_row_change on public.customers;
create trigger customers_audit_row_change after insert or update or delete on public.customers
  for each row execute function public.write_audit_log_for_row_change();
drop trigger if exists equipment_audit_row_change on public.equipment;
create trigger equipment_audit_row_change after insert or update or delete on public.equipment
  for each row execute function public.write_audit_log_for_row_change();
drop trigger if exists service_orders_audit_row_change on public.service_orders;
create trigger service_orders_audit_row_change after insert or update or delete on public.service_orders
  for each row execute function public.write_audit_log_for_row_change();
drop trigger if exists warranties_audit_row_change on public.warranties;
create trigger warranties_audit_row_change after insert or update or delete on public.warranties
  for each row execute function public.write_audit_log_for_row_change();
drop trigger if exists returns_audit_row_change on public.maintenance_returns;
create trigger returns_audit_row_change after insert or update or delete on public.maintenance_returns
  for each row execute function public.write_audit_log_for_row_change();
drop trigger if exists reports_audit_row_change on public.reports;
create trigger reports_audit_row_change after insert or update or delete on public.reports
  for each row execute function public.write_audit_log_for_row_change();
drop trigger if exists settings_audit_row_change on public.organization_settings;
create trigger settings_audit_row_change after insert or update or delete on public.organization_settings
  for each row execute function public.write_audit_log_for_row_change();

-- This SECURITY DEFINER helper returns only tenant IDs the signed-in user belongs to.
create or replace function public.current_user_org_ids()
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

create or replace function public.current_user_has_role(p_organization_id text, p_roles text[])
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

create or replace function public.complete_service_order(
  p_organization_id text,
  p_order_id text,
  p_notes text,
  p_checklist jsonb,
  p_photos jsonb,
  p_signature_path text,
  p_warranty_days integer,
  p_next_date date default null,
  p_next_service text default '',
  p_estimated_value numeric default 0,
  p_return_id text default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  service_order public.service_orders%rowtype;
begin
  if not public.current_user_has_role(p_organization_id, array['Administrador', 'Gestor', 'Técnico']) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_checklist is null or jsonb_typeof(p_checklist) <> 'array' or jsonb_array_length(p_checklist) > 30
     or p_photos is null or jsonb_typeof(p_photos) <> 'array' or jsonb_array_length(p_photos) > 6
     or p_warranty_days < 0 or p_warranty_days > 3650
     or char_length(coalesce(p_notes, '')) > 4000
     or char_length(coalesce(p_signature_path, '')) > 500 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;

  select * into service_order
  from public.service_orders
  where organization_id = p_organization_id and id = p_order_id
  for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if service_order.status = 'Concluído' then raise exception 'already_completed' using errcode = '23505'; end if;

  update public.service_orders
  set status = 'Concluído', notes = coalesce(p_notes, ''), checklist_json = p_checklist,
      photos_json = p_photos, signature_path = coalesce(p_signature_path, ''), completed_at = now()
  where organization_id = p_organization_id and id = p_order_id;

  if service_order.equipment_id is not null then
    update public.equipment set last_service = service_order.scheduled_date
    where organization_id = p_organization_id and id = service_order.equipment_id;
  end if;
  if p_warranty_days > 0 then
    insert into public.warranties (id, organization_id, customer_id, order_id, start_date, end_date, status)
    values ('g_' || replace(gen_random_uuid()::text, '-', ''), p_organization_id,
      service_order.customer_id, p_order_id, service_order.scheduled_date,
      service_order.scheduled_date + p_warranty_days, 'Ativa');
  end if;
  insert into public.reports (id, organization_id, order_id, created_at, summary)
  values ('la_' || replace(gen_random_uuid()::text, '-', ''), p_organization_id, p_order_id,
    current_date, coalesce(nullif(trim(p_notes), ''), 'Serviço concluído e validado com o cliente.'));
  if p_next_date is not null then
    insert into public.maintenance_returns
      (id, organization_id, customer_id, equipment_id, service, due_date, estimated_value, status, source_order_id)
    values ('r_' || replace(gen_random_uuid()::text, '-', ''), p_organization_id,
      service_order.customer_id, service_order.equipment_id,
      coalesce(nullif(trim(p_next_service), ''), 'Manutenção preventiva'), p_next_date,
      coalesce(p_estimated_value, service_order.value),
      case when p_next_date < current_date then 'Vencido' else 'Próximo' end, p_order_id);
  end if;
  if p_return_id is not null then
    update public.maintenance_returns set status = 'Convertido'
    where organization_id = p_organization_id and id = p_return_id and status <> 'Convertido';
  end if;
end;
$$;

create or replace function public.convert_maintenance_return(p_organization_id text, p_return_id text)
returns setof public.service_orders
language plpgsql
security invoker
set search_path = ''
as $$
declare
  maintenance_return public.maintenance_returns%rowtype;
  new_order_id text := 'os_' || replace(gen_random_uuid()::text, '-', '');
begin
  if not public.current_user_has_role(p_organization_id, array['Administrador', 'Gestor']) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into maintenance_return
  from public.maintenance_returns
  where organization_id = p_organization_id and id = p_return_id
  for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if maintenance_return.status = 'Convertido' then raise exception 'already_converted' using errcode = '23505'; end if;

  insert into public.service_orders
    (id, organization_id, customer_id, equipment_id, service, scheduled_date, status, technician, value)
  values (new_order_id, p_organization_id, maintenance_return.customer_id, maintenance_return.equipment_id,
    maintenance_return.service, current_date, 'Agendado', 'A definir', maintenance_return.estimated_value);
  update public.maintenance_returns set status = 'Convertido'
  where organization_id = p_organization_id and id = p_return_id;
  return query select * from public.service_orders
    where organization_id = p_organization_id and id = new_order_id;
end;
$$;

revoke all on function public.current_user_org_ids() from public, anon;
grant execute on function public.current_user_org_ids() to authenticated;
revoke all on function public.current_user_has_role(text, text[]) from public, anon;
grant execute on function public.current_user_has_role(text, text[]) to authenticated;
revoke all on function public.complete_service_order(text, text, text, jsonb, jsonb, text, integer, date, text, numeric, text) from public, anon;
grant execute on function public.complete_service_order(text, text, text, jsonb, jsonb, text, integer, date, text, numeric, text) to authenticated;
revoke all on function public.convert_maintenance_return(text, text) from public, anon;
grant execute on function public.convert_maintenance_return(text, text) to authenticated;

create or replace function public.create_profile_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, name, email)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1)),
    coalesce(new.email, '')
  )
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

revoke all on function public.create_profile_for_auth_user() from public, anon, authenticated;
drop trigger if exists create_profile_after_auth_user on auth.users;
create trigger create_profile_after_auth_user
  after insert on auth.users
  for each row execute function public.create_profile_for_auth_user();

alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.org_members enable row level security;
alter table public.customers enable row level security;
alter table public.equipment enable row level security;
alter table public.service_orders enable row level security;
alter table public.warranties enable row level security;
alter table public.maintenance_returns enable row level security;
alter table public.reports enable row level security;
alter table public.organization_settings enable row level security;
alter table public.audit_logs enable row level security;

create policy organizations_read_member on public.organizations
  for select to authenticated using (id in (select public.current_user_org_ids()));
create policy profiles_read_self on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy members_read_same_org on public.org_members
  for select to authenticated using (organization_id in (select public.current_user_org_ids()));

create policy customers_org_read on public.customers
  for select to authenticated using (organization_id in (select public.current_user_org_ids()));
create policy customers_org_write on public.customers
  for all to authenticated
  using (public.current_user_has_role(organization_id, array['Administrador', 'Gestor']))
  with check (public.current_user_has_role(organization_id, array['Administrador', 'Gestor']));
create policy equipment_org_read on public.equipment
  for select to authenticated using (organization_id in (select public.current_user_org_ids()));
create policy equipment_org_write on public.equipment
  for all to authenticated
  using (public.current_user_has_role(organization_id, array['Administrador', 'Gestor', 'Técnico']))
  with check (public.current_user_has_role(organization_id, array['Administrador', 'Gestor', 'Técnico']));
create policy service_orders_org_read on public.service_orders
  for select to authenticated using (organization_id in (select public.current_user_org_ids()));
create policy service_orders_org_insert on public.service_orders
  for insert to authenticated
  with check (public.current_user_has_role(organization_id, array['Administrador', 'Gestor']));
create policy service_orders_org_update on public.service_orders
  for update to authenticated
  using (public.current_user_has_role(organization_id, array['Administrador', 'Gestor', 'Técnico']))
  with check (public.current_user_has_role(organization_id, array['Administrador', 'Gestor', 'Técnico']));
create policy service_orders_org_delete on public.service_orders
  for delete to authenticated
  using (public.current_user_has_role(organization_id, array['Administrador']));
create policy warranties_org_read on public.warranties
  for select to authenticated using (organization_id in (select public.current_user_org_ids()));
create policy warranties_org_write on public.warranties
  for all to authenticated
  using (public.current_user_has_role(organization_id, array['Administrador', 'Gestor', 'Técnico']))
  with check (public.current_user_has_role(organization_id, array['Administrador', 'Gestor', 'Técnico']));
create policy returns_org_read on public.maintenance_returns
  for select to authenticated using (organization_id in (select public.current_user_org_ids()));
create policy returns_org_insert on public.maintenance_returns
  for insert to authenticated
  with check (public.current_user_has_role(organization_id, array['Administrador', 'Gestor', 'Técnico']));
create policy returns_org_update on public.maintenance_returns
  for update to authenticated
  using (public.current_user_has_role(organization_id, array['Administrador', 'Gestor']))
  with check (public.current_user_has_role(organization_id, array['Administrador', 'Gestor']));
create policy returns_org_complete on public.maintenance_returns
  for update to authenticated
  using (public.current_user_has_role(organization_id, array['Administrador', 'Gestor', 'Técnico']))
  with check (status = 'Convertido' and public.current_user_has_role(organization_id, array['Administrador', 'Gestor', 'Técnico']));
create policy returns_org_delete on public.maintenance_returns
  for delete to authenticated
  using (public.current_user_has_role(organization_id, array['Administrador', 'Gestor']));
create policy reports_org_read on public.reports
  for select to authenticated using (organization_id in (select public.current_user_org_ids()));
create policy reports_org_write on public.reports
  for all to authenticated
  using (public.current_user_has_role(organization_id, array['Administrador', 'Gestor', 'Técnico']))
  with check (public.current_user_has_role(organization_id, array['Administrador', 'Gestor', 'Técnico']));
create policy settings_org_scope on public.organization_settings
  for all to authenticated
  using (public.current_user_has_role(organization_id, array['Administrador']))
  with check (public.current_user_has_role(organization_id, array['Administrador']));
create policy settings_org_read on public.organization_settings
  for select to authenticated using (organization_id in (select public.current_user_org_ids()));
create policy audit_org_read on public.audit_logs
  for select to authenticated
  using (organization_id in (select public.current_user_org_ids())
    and public.current_user_has_role(organization_id, array['Administrador']));

-- Evidence belongs in a private Storage bucket named `service-evidence`.
-- The bucket is created/configured in Supabase before applying this migration.
create policy service_evidence_read_member on storage.objects
  for select to authenticated
  using (bucket_id = 'service-evidence'
    and (storage.foldername(name))[1] in (select public.current_user_org_ids()));
create policy service_evidence_upload_technician on storage.objects
  for insert to authenticated
  with check (bucket_id = 'service-evidence'
    and (storage.foldername(name))[1] in (select public.current_user_org_ids())
    and public.current_user_has_role((storage.foldername(name))[1], array['Administrador', 'Gestor', 'Técnico']));
create policy service_evidence_delete_manager on storage.objects
  for delete to authenticated
  using (bucket_id = 'service-evidence'
    and (storage.foldername(name))[1] in (select public.current_user_org_ids())
    and public.current_user_has_role((storage.foldername(name))[1], array['Administrador', 'Gestor']));

-- Audit records are append-only. Writes are performed through the API after role checks.
revoke insert, update, delete, truncate, references, trigger on public.audit_logs from anon, authenticated;

-- No public grants: authenticated clients receive only the operations guarded by RLS.
revoke all on public.organizations, public.profiles, public.org_members,
  public.customers, public.equipment, public.service_orders, public.warranties,
  public.maintenance_returns, public.reports, public.organization_settings,
  public.audit_logs from anon;
grant select on public.organizations, public.profiles, public.org_members,
  public.customers, public.equipment, public.service_orders, public.warranties,
  public.maintenance_returns, public.reports, public.organization_settings,
  public.audit_logs to authenticated;
grant insert, update, delete on public.customers, public.equipment,
  public.service_orders, public.warranties, public.maintenance_returns,
  public.reports, public.organization_settings to authenticated;
