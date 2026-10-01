alter table public.maintenance_returns
  add column if not exists last_contacted_at timestamptz,
  add column if not exists next_action_date date,
  add column if not exists converted_order_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'maintenance_returns_converted_order_fk'
      and conrelid = 'public.maintenance_returns'::regclass
  ) then
    alter table public.maintenance_returns
      add constraint maintenance_returns_converted_order_fk
      foreign key (organization_id, converted_order_id)
      references public.service_orders(organization_id, id);
  end if;
end;
$$;

alter table public.maintenance_returns
  drop constraint if exists maintenance_returns_status_check;

alter table public.maintenance_returns
  add constraint maintenance_returns_status_check
  check (status in (
    'Vencido', 'Próximo', 'Contato preparado', 'Contatado', 'Respondeu',
    'Agendado', 'Convertido', 'Sem interesse', 'Número inválido',
    'Não contatar', 'Cancelado'
  ));

create table if not exists public.contact_attempts (
  id text not null,
  organization_id text not null references public.organizations(id) on delete cascade,
  return_id text not null,
  user_id uuid not null references auth.users(id) on delete restrict,
  outcome text not null check (outcome in (
    'Contatado', 'Respondeu', 'Sem interesse',
    'Número inválido', 'Não contatar'
  )),
  note text not null default '' check (char_length(note) <= 500),
  follow_up_date date,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  foreign key (organization_id, return_id)
    references public.maintenance_returns(organization_id, id) on delete cascade
);

create index if not exists contact_attempts_org_return_created_idx
  on public.contact_attempts(organization_id, return_id, created_at desc);

drop trigger if exists contact_attempts_audit_row_change on public.contact_attempts;
create trigger contact_attempts_audit_row_change
  after insert on public.contact_attempts
  for each row execute function public.write_audit_log_for_row_change();

alter table public.contact_attempts enable row level security;

create policy return_contacts_read_member on public.contact_attempts
  for select to authenticated
  using (organization_id in (select public.current_user_org_ids()));

create policy return_contacts_create_manager on public.contact_attempts
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and public.current_user_has_role(organization_id, array['Administrador', 'Gestor'])
  );

revoke all on public.contact_attempts from anon;
grant select, insert on public.contact_attempts to authenticated;

create or replace function public.record_maintenance_return_contact(
  p_organization_id text,
  p_return_id text,
  p_outcome text,
  p_note text default '',
  p_follow_up_date date default null
)
returns setof public.contact_attempts
language plpgsql
security invoker
set search_path = ''
as $$
declare
  return_row public.maintenance_returns%rowtype;
  contact_row public.contact_attempts%rowtype;
begin
  if not public.current_user_has_role(p_organization_id, array['Administrador', 'Gestor']) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_outcome not in ('Contatado', 'Respondeu', 'Sem interesse', 'Número inválido', 'Não contatar')
     or char_length(coalesce(p_note, '')) > 500 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;

  select * into return_row
  from public.maintenance_returns
  where organization_id = p_organization_id and id = p_return_id
  for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if return_row.status in ('Convertido', 'Cancelado', 'Não contatar') then
    raise exception 'closed_return' using errcode = '23514';
  end if;

  insert into public.contact_attempts
    (id, organization_id, return_id, user_id, outcome, note, follow_up_date)
  values (
    'ct_' || replace(gen_random_uuid()::text, '-', ''), p_organization_id,
    p_return_id, (select auth.uid()), p_outcome, coalesce(p_note, ''), p_follow_up_date
  ) returning * into contact_row;

  update public.maintenance_returns
  set status = p_outcome, last_contacted_at = now(), next_action_date = p_follow_up_date
  where organization_id = p_organization_id and id = p_return_id;
  return next contact_row;
end;
$$;

revoke all on function public.record_maintenance_return_contact(text, text, text, text, date) from public, anon;
grant execute on function public.record_maintenance_return_contact(text, text, text, text, date) to authenticated;

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
  if maintenance_return.status in ('Convertido', 'Cancelado', 'Sem interesse', 'Número inválido', 'Não contatar') then
    raise exception 'closed_return' using errcode = '23514';
  end if;

  insert into public.service_orders
    (id, organization_id, customer_id, equipment_id, service, scheduled_date, status, technician, value)
  values (new_order_id, p_organization_id, maintenance_return.customer_id, maintenance_return.equipment_id,
    maintenance_return.service, current_date, 'Agendado', 'A definir', maintenance_return.estimated_value);
  update public.maintenance_returns
  set status = 'Convertido', converted_order_id = new_order_id
  where organization_id = p_organization_id and id = p_return_id;
  return query select * from public.service_orders
  where organization_id = p_organization_id and id = new_order_id;
end;
$$;
