-- 2. Catálogos del sistema: iguales en todas las instancias (DATABASE.md §5 y §7).
-- Los datos se generan desde src/lib/domain/catalog.ts (la misma fuente que usa
-- la interfaz): ver 20261003190200_catalog_data.sql.

create table public.modules (
  code text primary key,
  name text not null,
  is_lockable boolean not null default true, -- el núcleo no se puede bloquear
  sort int not null default 0
);

create table public.roles (
  code text primary key,
  name text not null,
  island int,
  default_sector_code text,
  description text not null default '',
  is_supervisor boolean not null default false, -- DOCENTE: todos los permisos, ignora bloqueos de módulos
  sort int not null default 0
);

create table public.permissions (
  code text primary key,
  module_code text not null references public.modules (code),
  resource text not null,
  action text not null check (action in ('read', 'create', 'update', 'approve', 'cancel', 'delete', 'export')),
  check (code = resource || '.' || action)
);

create table public.role_permissions (
  role_code text not null references public.roles (code) on delete cascade,
  permission_code text not null references public.permissions (code) on delete cascade,
  primary key (role_code, permission_code)
);

create table public.units_of_measure (
  code text primary key,
  name text not null,
  allows_decimals boolean not null default true
);

create table public.document_types (
  code text primary key,
  prefix text not null unique,
  name text not null,
  plural text not null,
  module_code text not null references public.modules (code),
  resource text not null, -- raíz de los permisos: purchase_order.read, purchase_order.approve…
  path text not null, -- ruta en la interfaz: compras/ordenes
  description text not null default ''
);

create table public.document_statuses (
  doc_type text not null references public.document_types (code) on delete cascade,
  code text not null,
  label text not null,
  description text not null default '',
  badge text not null check (badge in ('neutral', 'info', 'warning', 'success', 'danger')),
  is_final boolean not null default false,
  sort int not null default 0,
  primary key (doc_type, code)
);

create table public.document_transitions (
  doc_type text not null,
  from_status text not null,
  action text not null check (
    action in ('SUBMIT', 'APPROVE', 'REJECT', 'WITHDRAW', 'REOPEN', 'SEND', 'CONFIRM', 'CANCEL', 'CLOSE', 'SYSTEM')
  ),
  to_status text not null,
  permission_code text references public.permissions (code), -- null sólo en transiciones del sistema
  label text not null default '',
  help_text text not null default '',
  requires_comment boolean not null default false,
  tone text not null default 'default' check (tone in ('default', 'outline', 'destructive')),
  sort int not null default 0, -- orden de los botones de acción en el documento
  primary key (doc_type, from_status, action, to_status),
  foreign key (doc_type, from_status) references public.document_statuses (doc_type, code),
  foreign key (doc_type, to_status) references public.document_statuses (doc_type, code),
  check ((action = 'SYSTEM') = (permission_code is null))
);

create table public.task_rules (
  doc_type text not null,
  status text not null,
  task_type text not null,
  assignee_kind text not null check (assignee_kind in ('ROLE', 'APPROVER', 'CREATOR')),
  role_code text references public.roles (code),
  title_template text not null, -- 'Aprobar {number} por {total}'
  description text not null default '',
  primary key (doc_type, status, task_type),
  foreign key (doc_type, status) references public.document_statuses (doc_type, code),
  check ((assignee_kind = 'ROLE') = (role_code is not null))
);

create table public.stock_movement_types (
  code text primary key,
  name text not null,
  direction smallint not null check (direction in (1, -1))
);

-- Verbo de cada acción para los resúmenes de auditoría ("Aprobó OC-00023…").
create table public.audit_actions (
  code text primary key,
  verb text not null
);

-- Lectura para cualquier usuario con sesión (son metadatos del sistema); nadie
-- los modifica desde la aplicación: cambian sólo por migración.
do $$
declare
  t text;
begin
  foreach t in array array[
    'modules', 'roles', 'permissions', 'role_permissions', 'units_of_measure', 'document_types',
    'document_statuses', 'document_transitions', 'task_rules', 'stock_movement_types', 'audit_actions'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_select', t);
  end loop;
end;
$$;
