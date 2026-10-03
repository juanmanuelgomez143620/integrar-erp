-- 7. Auditoría de sólo inserción (DATABASE.md §10): nadie la modifica ni la
-- borra, ni siquiera el docente. Es la base del control interno.

create table public.audit_events (
  id bigint generated always as identity primary key,
  company_id uuid references public.companies (id) on delete cascade, -- null: eventos de la escuela
  occurred_at timestamptz not null default now(),
  actor_user_id uuid, -- null = sistema
  actor_name text not null,
  actor_role_code text not null,
  actor_sector_id uuid,
  actor_sector_name text not null default '—',
  action text not null, -- CREATE, UPDATE, SUBMIT, APPROVE, REJECT, SEND, CONFIRM, CANCEL…
  entity_type text not null, -- 'purchase_order', 'product', 'member_role'…
  entity_id uuid,
  entity_label text not null default '',
  document_id uuid, -- FK a documents en la migración de documentos
  from_status text,
  to_status text,
  summary text not null,
  changes jsonb, -- diferencias campo a campo
  metadata jsonb
);
create index audit_events_company_idx on public.audit_events (company_id, id desc);
create index audit_events_document_idx on public.audit_events (document_id);

create trigger audit_events_immutable before update or delete on public.audit_events
  for each row execute function private.forbid_mutation();

create function private.log_audit(
  p_company uuid,
  p_actor private.actor,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_entity_label text,
  p_summary text,
  p_document uuid default null,
  p_from_status text default null,
  p_to_status text default null,
  p_changes jsonb default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_events (
    company_id, actor_user_id, actor_name, actor_role_code, actor_sector_id, actor_sector_name,
    action, entity_type, entity_id, entity_label, document_id, from_status, to_status, summary, changes
  ) values (
    p_company, (p_actor).user_id, (p_actor).name, (p_actor).role_code, (p_actor).sector_id, (p_actor).sector_name,
    p_action, p_entity_type, p_entity_id, coalesce(p_entity_label, ''), p_document, p_from_status, p_to_status,
    p_summary, nullif(p_changes, '{}'::jsonb)
  )
$$;

-- Diferencias entre dos versiones de un registro, sólo en las columnas indicadas.
create function private.diff(p_before jsonb, p_after jsonb, p_keys text[])
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(k, jsonb_build_object('from', p_before -> k, 'to', p_after -> k)), '{}'::jsonb)
    from unnest(p_keys) as k
   where (p_before -> k) is distinct from (p_after -> k)
$$;

alter table public.audit_events enable row level security;
revoke all on table public.audit_events from anon, authenticated;
grant select on table public.audit_events to authenticated;
-- Con audit.read se ve todo lo de la empresa; sin él, lo que hizo uno mismo.
-- (La vista de auditoría por documento se arma con una RPC de lectura.)
create policy audit_events_select on public.audit_events for select to authenticated
  using (
    company_id in (select private.companies_with_permission('audit.read'))
    or actor_user_id = (select auth.uid())
  );
