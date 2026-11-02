-- 78. Fase 8a.1 (docs/FASE_8_BANCO_Y_FISCO.md §3): el Banco Aula. La cuenta corriente de cada
-- empresa en el banco del entorno, vinculada a Banco cuenta corriente, y sus movimientos: el
-- saldo inicial y las órdenes que le llegan de cada asiento registrado que mueve esa cuenta (un
-- pago, un cobro, una transferencia entre cuentas, el pago de los sueldos, de las cargas sociales
-- o de un impuesto, o un asiento manual). El banco lo opera Tesorería: un integrante que no envió la
-- orden la procesa (SoD-12); si el docente lo pide, la procesa el sistema en el momento. Traducción
-- de la sección "Banco Aula" de src/lib/mock/engine.ts y de bankAccountView en queries.ts.
--
-- El módulo y los permisos están en la migración de catálogos siguiente; la plantilla, en la de la
-- plantilla; las empresas que ya existían reciben su cuenta (con lo que ya movió el banco, procesado
-- con la fecha de cada asiento) en la última de esta fase.

-- La acción "operate" (bank.operate: procesar las órdenes del banco).
alter table public.permissions drop constraint permissions_action_check;
alter table public.permissions add constraint permissions_action_check
  check (action in ('read', 'create', 'update', 'approve', 'cancel', 'delete', 'export', 'pay', 'award', 'issue', 'operate'));

-- ------------------------------------------------------------------ Tablas

-- La cuenta de la empresa en el Banco Aula: una por empresa en esta fase. Número, clave y alias
-- tienen formato propio (no son los de un banco real); el acuerdo de descubierto se usa desde la 8b.
create table public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  ledger_account_id uuid not null,
  number text not null check (length(number) between 4 and 20),
  bank_key text not null check (bank_key ~ '^SIM[0-9]{16}$'),
  alias text not null check (alias ~ '^[A-Z0-9.]{6,20}$'),
  opened_on date not null,
  overdraft_limit numeric(14, 2) not null default 0 check (overdraft_limit >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  unique (company_id, ledger_account_id),
  unique (company_id, id),
  foreign key (company_id, ledger_account_id) references public.accounts (company_id, id)
);

create trigger bank_accounts_audit before insert or update on public.bank_accounts
  for each row execute function private.set_audit_fields();
alter table public.bank_accounts enable row level security;
revoke all on table public.bank_accounts from anon, authenticated;
grant select on table public.bank_accounts to authenticated;
create trigger bank_accounts_same_company before update on public.bank_accounts
  for each row execute function private.prevent_company_change();
create policy bank_accounts_select on public.bank_accounts for select to authenticated
  using (company_id in (select private.companies_with_permission('bank.read')));

-- Un movimiento de la cuenta: el saldo inicial (APERTURA), una orden de la empresa (ORDEN) o,
-- desde la 8b, un cargo del banco (BANCO). El sentido es el del extracto: crédito, entra dinero;
-- débito, sale. Pendiente hasta que el banco la procesa (fecha y número de transacción) o la anula.
create table public.bank_movements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  bank_account_id uuid not null,
  seq int not null check (seq > 0),
  origin text not null check (origin in ('APERTURA', 'ORDEN', 'BANCO')),
  direction text not null check (direction in ('CREDITO', 'DEBITO')),
  amount numeric(14, 2) not null check (amount >= 0),
  concept text not null,
  source_document_id uuid,
  journal_line_id uuid references public.journal_entry_lines (id),
  reverses_id uuid,
  ordered_by uuid, -- quién la envió con su operación: no la procesa (SoD-12)
  status text not null default 'PENDIENTE' check (status in ('PENDIENTE', 'PROCESADO', 'ANULADO')),
  received_on date not null,
  processed_on date,
  transaction_number text check (transaction_number ~ '^SIM-[0-9]{6}$'),
  processed_by uuid,
  created_at timestamptz not null default now(),
  unique (bank_account_id, seq),
  unique (company_id, id),
  check ((status = 'PROCESADO') = (processed_on is not null)),
  foreign key (company_id, bank_account_id) references public.bank_accounts (company_id, id) on delete cascade,
  foreign key (company_id, source_document_id) references public.documents (company_id, id),
  foreign key (company_id, reverses_id) references public.bank_movements (company_id, id)
);

create index bank_movements_account_status on public.bank_movements (bank_account_id, status);
create index bank_movements_journal_line on public.bank_movements (journal_line_id);
alter table public.bank_movements enable row level security;
revoke all on table public.bank_movements from anon, authenticated;
grant select on table public.bank_movements to authenticated;
create trigger bank_movements_same_company before update on public.bank_movements
  for each row execute function private.prevent_company_change();
create policy bank_movements_select on public.bank_movements for select to authenticated
  using (company_id in (select private.companies_with_permission('bank.read')));

-- ------------------------------------------------------------------ Auxiliares

-- Quién opera el banco: Tesorería, salvo que el docente pida que lo opere el sistema (bankMode).
create function private.bank_mode(p_company uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$ select coalesce((select c.settings ->> 'bank_mode' from public.companies c where c.id = p_company), 'ESTUDIANTES') $$;

-- "FORESTAL.NORTE.BA": el alias de la cuenta, con las dos primeras palabras del nombre (bankAlias).
create function private.bank_alias(p_slug text)
returns text
language sql
immutable
set search_path = ''
as $$
  select left(coalesce(upper(string_agg(x.w, '.' order by x.n)), 'EMPRESA'), 17) || '.BA'
    from (select t.w, t.n from unnest(string_to_array(p_slug, '-')) with ordinality as t (w, n)
           where t.w ~ '^[a-z]{4,}$' order by t.n limit 2) x
$$;

-- Un movimiento que llega a la cuenta, pendiente, con el número que sigue en el orden de llegada.
-- La fila de la cuenta queda bloqueada: el número de llegada y el de transacción son correlativos.
create function private.bank_add_movement(
  p_account public.bank_accounts,
  p_origin text,
  p_direction text,
  p_amount numeric,
  p_concept text,
  p_source uuid,
  p_line uuid,
  p_reverses uuid,
  p_on date,
  p_ordered_by uuid
)
returns public.bank_movements
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seq int;
  v_row public.bank_movements;
begin
  perform 1 from public.bank_accounts b where b.id = p_account.id for update;
  select coalesce(max(m.seq), 0) + 1 into v_seq from public.bank_movements m where m.bank_account_id = p_account.id;
  insert into public.bank_movements (company_id, bank_account_id, seq, origin, direction, amount, concept,
                                     source_document_id, journal_line_id, reverses_id, ordered_by, status, received_on)
  values (p_account.company_id, p_account.id, v_seq, p_origin, p_direction, p_amount, p_concept,
          p_source, p_line, p_reverses, p_ordered_by, 'PENDIENTE', p_on)
  returning * into v_row;
  return v_row;
end;
$$;

-- El banco procesa un movimiento: queda en el extracto con su fecha y el número de transacción que sigue.
create function private.bank_process_movement(p_id uuid, p_on date, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account uuid;
  v_count int;
begin
  select m.bank_account_id into v_account from public.bank_movements m where m.id = p_id;
  perform 1 from public.bank_accounts b where b.id = v_account for update;
  select count(*) into v_count
    from public.bank_movements m where m.bank_account_id = v_account and m.transaction_number is not null;
  update public.bank_movements
     set status = 'PROCESADO', processed_on = p_on, transaction_number = 'SIM-' || lpad((v_count + 1)::text, 6, '0'),
         processed_by = p_user
   where id = p_id;
end;
$$;

-- Mientras haya órdenes pendientes, Tesorería tiene una tarea abierta para procesarlas en el banco (syncBankTask).
create function private.bank_sync_task(p_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_open uuid;
  v_task uuid;
begin
  select t.id into v_open from public.tasks t
   where t.company_id = p_company and t.task_type = 'PROCESAR_BANCO' and t.status in ('PENDIENTE', 'EN_CURSO')
   order by t.created_at limit 1;
  if not exists (select 1 from public.bank_movements m where m.company_id = p_company and m.status = 'PENDIENTE') then
    if v_open is not null then
      update public.tasks set status = 'RESUELTA', completed_by = (select auth.uid()), completed_at = now()
       where id = v_open;
    end if;
    return;
  end if;
  if v_open is not null then
    return;
  end if;
  insert into public.tasks (company_id, task_type, title, description, context, assigned_role, priority)
  values (p_company, 'PROCESAR_BANCO', 'Procesar las órdenes del Banco Aula',
          'Llegaron órdenes al banco (pagos, cobros, depósitos o transferencias): las procesa desde la bandeja un integrante de Tesorería que no las envió.',
          '{}', 'TESORERIA', 'NORMAL')
  returning id into v_task;
  perform private.notify_roles(
    p_company, array['TESORERIA'], 'NUEVA_TAREA', 'Órdenes en el Banco Aula',
    'Llegaron órdenes al banco: procesalas desde la bandeja (no las que enviaste vos).',
    '/e/' || (select c.slug from public.companies c where c.id = p_company) || '/pagos/banco-aula/bandeja', null, v_task
  );
end;
$$;

-- Lo que llega al banco: en modo automático se procesa en el momento; si no, espera en la bandeja
-- (settleBankOrders).
create function private.bank_settle(p_company uuid, p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_today date := private.business_date(p_company);
begin
  if private.bank_mode(p_company) = 'AUTOMATICO' then
    foreach v_id in array p_ids loop
      perform private.bank_process_movement(v_id, v_today, null);
    end loop;
  end if;
  perform private.bank_sync_task(p_company);
end;
$$;

-- La operación que originó un asiento automático (la que lo enlaza); la de un manual es el asiento mismo.
create function private.bank_entry_source(p_entry uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select d.id from public.document_links k join public.documents d on d.id = k.from_document_id
     where k.to_document_id = p_entry and d.doc_type <> 'JOURNAL_ENTRY'
     order by d.created_at, d.id limit 1), p_entry)
$$;

-- Las órdenes que un asiento registrado manda al banco: una por cada línea en la cuenta contable de
-- un banco del Banco Aula, con el concepto del asiento (sendBankOrders).
create function private.bank_send_orders(p_source public.documents, p_entry public.documents)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line public.journal_entry_lines;
  v_account public.bank_accounts;
  v_row public.bank_movements;
  v_ids uuid[] := '{}';
  v_today date := private.business_date(p_entry.company_id);
  v_concept text;
begin
  select regexp_replace(je.description, '\.$', '') into v_concept
    from public.journal_entries je where je.document_id = p_entry.id;
  for v_line in select l.* from public.journal_entry_lines l where l.document_id = p_entry.id order by l.line_no loop
    select * into v_account from public.bank_accounts b where b.ledger_account_id = v_line.account_id and b.is_active;
    continue when not found;
    v_row := private.bank_add_movement(v_account, 'ORDEN',
      case when v_line.debit > 0 then 'CREDITO' else 'DEBITO' end,
      case when v_line.debit > 0 then v_line.debit else v_line.credit end,
      v_concept, p_source.id, v_line.id, null, v_today, (select auth.uid()));
    v_ids := v_ids || v_row.id;
  end loop;
  if cardinality(v_ids) > 0 then
    perform private.bank_settle(p_entry.company_id, v_ids);
  end if;
end;
$$;

-- Al anular un asiento (o la operación que lo generó), el contraasiento retira la orden que el banco
-- todavía no procesó y, si ya la procesó, le manda la orden inversa (reverseBankOrders).
create function private.bank_reverse_orders(p_reversal public.documents)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_original uuid;
  v_order public.bank_movements;
  v_line public.journal_entry_lines;
  v_mirror uuid;
  v_account public.bank_accounts;
  v_row public.bank_movements;
  v_ids uuid[] := '{}';
  v_withdrawn boolean := false;
  v_today date := private.business_date(p_reversal.company_id);
begin
  select je.reverses_id into v_original from public.journal_entries je where je.document_id = p_reversal.id;
  if v_original is null then
    return;
  end if;
  for v_order in
    select m.* from public.bank_movements m join public.journal_entry_lines l on l.id = m.journal_line_id
     where l.document_id = v_original and m.origin = 'ORDEN' and m.reverses_id is null
     order by m.seq
  loop
    if v_order.status = 'PENDIENTE' then
      update public.bank_movements set status = 'ANULADO' where id = v_order.id;
      v_withdrawn := true;
      continue;
    end if;
    continue when v_order.status <> 'PROCESADO';
    select * into v_line from public.journal_entry_lines l where l.id = v_order.journal_line_id;
    select l.id into v_mirror from public.journal_entry_lines l
     where l.document_id = p_reversal.id and l.account_id = v_line.account_id
       and l.debit = v_line.credit and l.credit = v_line.debit
     order by l.line_no limit 1;
    select * into v_account from public.bank_accounts b where b.id = v_order.bank_account_id;
    v_row := private.bank_add_movement(v_account, 'ORDEN',
      case when v_order.direction = 'CREDITO' then 'DEBITO' else 'CREDITO' end, v_order.amount,
      'Reversión de ' || v_order.transaction_number || ': ' || v_order.concept,
      v_order.source_document_id, v_mirror, v_order.id, v_today, (select auth.uid()));
    v_ids := v_ids || v_row.id;
  end loop;
  if cardinality(v_ids) > 0 then
    perform private.bank_settle(p_reversal.company_id, v_ids);
  elsif v_withdrawn then
    perform private.bank_sync_task(p_reversal.company_id);
  end if;
end;
$$;

-- Abre la cuenta corriente de la empresa en el Banco Aula, vinculada a Banco cuenta corriente. El
-- saldo inicial es el del asiento de apertura y, en una empresa que ya operaba, lo que movió el banco
-- queda procesado con la fecha de cada asiento. No hace nada si la empresa ya tiene su cuenta
-- (openBankAccount).
create function private.bank_open_account(p_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ledger public.accounts;
  v_opened date;
  v_open_line uuid;
  v_balance numeric;
  v_account public.bank_accounts;
  v_row public.bank_movements;
  v_r record;
  v_original uuid;
  v_order public.bank_movements;
begin
  if exists (select 1 from public.bank_accounts b where b.company_id = p_company) then
    return;
  end if;
  select * into v_ledger from public.accounts a where a.company_id = p_company and a.code = '1.1.01.03';
  if not found then
    return;
  end if;
  select d.document_date, l.id into v_opened, v_open_line
    from public.journal_entry_lines l
    join public.documents d on d.id = l.document_id
    join public.journal_entries je on je.document_id = d.id
   where l.account_id = v_ledger.id and je.entry_number is not null and je.origin = 'APERTURA'
   order by d.document_date, je.entry_number, l.line_no
   limit 1;
  select coalesce(sum(l.debit - l.credit), 0) into v_balance
    from public.journal_entry_lines l join public.journal_entries je on je.document_id = l.document_id
   where l.account_id = v_ledger.id and je.entry_number is not null and je.origin = 'APERTURA';
  v_opened := coalesce(v_opened,
    (select min(y.start_date) from public.fiscal_years y where y.company_id = p_company),
    private.business_date(p_company));
  insert into public.bank_accounts (company_id, ledger_account_id, number, bank_key, alias, opened_on, overdraft_limit)
  values (p_company, v_ledger.id, 'CC 0001-000001', 'SIM0001000000000017',
          private.bank_alias((select c.slug from public.companies c where c.id = p_company)), v_opened, 1000000)
  returning * into v_account;
  v_row := private.bank_add_movement(v_account, 'APERTURA', case when v_balance < 0 then 'DEBITO' else 'CREDITO' end,
    abs(v_balance), 'Saldo inicial de la cuenta', null, v_open_line, null, v_opened, null);
  -- El saldo inicial no es una transacción: no lleva número.
  update public.bank_movements set status = 'PROCESADO', processed_on = v_opened where id = v_row.id;
  for v_r in
    select l.*, d.document_date, je.origin, je.reverses_id, je.description
      from public.journal_entry_lines l
      join public.documents d on d.id = l.document_id
      join public.journal_entries je on je.document_id = d.id
     where l.account_id = v_ledger.id and je.entry_number is not null and je.origin <> 'APERTURA'
     order by d.document_date, je.entry_number, l.line_no
  loop
    if v_r.origin <> 'CONTRAASIENTO' then
      v_row := private.bank_add_movement(v_account, 'ORDEN',
        case when v_r.debit > 0 then 'CREDITO' else 'DEBITO' end,
        case when v_r.debit > 0 then v_r.debit else v_r.credit end,
        regexp_replace(v_r.description, '\.$', ''), private.bank_entry_source(v_r.document_id), v_r.id, null,
        v_r.document_date, null);
      perform private.bank_process_movement(v_row.id, v_r.document_date, null);
      continue;
    end if;
    select l.id into v_original from public.journal_entry_lines l
     where l.document_id = v_r.reverses_id and l.account_id = v_r.account_id
       and l.debit = v_r.credit and l.credit = v_r.debit
     order by l.line_no limit 1;
    select * into v_order from public.bank_movements m where m.journal_line_id = v_original and m.reverses_id is null;
    continue when not found;
    v_row := private.bank_add_movement(v_account, 'ORDEN',
      case when v_order.direction = 'CREDITO' then 'DEBITO' else 'CREDITO' end, v_order.amount,
      'Reversión de ' || v_order.transaction_number || ': ' || v_order.concept,
      v_order.source_document_id, v_r.id, v_order.id, v_r.document_date, null);
    perform private.bank_process_movement(v_row.id, v_r.document_date, null);
  end loop;
end;
$$;

-- ------------------------------------------------------------------ Comandos

-- Tesorería procesa en el banco órdenes pendientes con la fecha del día, en el orden en que llegaron.
-- SoD-12: quien envió una orden (con su pago, cobro, transferencia o asiento) no la procesa (cmdProcessBankOrders).
create function public.bank_orders_process(p_company_id uuid, p_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'bank.operate');
  v_sod boolean := coalesce((select (c.settings ->> 'sod_enabled')::boolean from public.companies c
                             where c.id = p_company_id), true)
                   and not private.is_supervisor(p_company_id);
  v_id uuid;
  v_order public.bank_movements;
  v_ids uuid[] := '{}';
  v_today date := private.business_date(p_company_id);
  v_account public.bank_accounts;
  v_summary text;
begin
  if coalesce(cardinality(p_ids), 0) = 0 then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí las órdenes que procesa el banco.');
  end if;
  if (select count(distinct x) from unnest(p_ids) as x) <> cardinality(p_ids) then
    perform private.raise_business_error('DATO_INVALIDO', 'Una orden está dos veces.');
  end if;
  foreach v_id in array p_ids loop
    select * into v_order from public.bank_movements m
     where m.id = v_id and m.company_id = p_company_id and m.origin = 'ORDEN';
    if not found then
      perform private.raise_business_error('DATO_INVALIDO', 'Una de las órdenes no es de esta empresa.');
    end if;
    if v_order.status <> 'PENDIENTE' then
      perform private.raise_business_error('TRANSICION_INVALIDA',
        format('La orden N.º %s ya está %s.', v_order.seq,
               case v_order.status when 'PROCESADO' then 'procesada' else 'anulada' end));
    end if;
    if v_sod and v_order.ordered_by = (select auth.uid()) then
      perform private.raise_business_error('SEPARACION_FUNCIONES',
        format('No podés procesar la orden N.º %s: la enviaste vos.', v_order.seq),
        'Separación de funciones (SoD-12): quien envía una orden al banco no la procesa. Tiene que procesarla otro integrante de Tesorería.');
    end if;
  end loop;
  for v_order in select m.* from public.bank_movements m where m.id = any (p_ids) order by m.seq loop
    perform private.bank_process_movement(v_order.id, v_today, (select auth.uid()));
    v_ids := v_ids || v_order.id;
  end loop;
  perform private.bank_sync_task(p_company_id);
  select string_agg(format('%s (%s de %s)', m.transaction_number,
                           case m.direction when 'CREDITO' then 'crédito' else 'débito' end,
                           private.format_money(m.amount)), ', ' order by m.seq)
    into v_summary
    from public.bank_movements m where m.id = any (v_ids);
  select b.* into v_account from public.bank_accounts b
    join public.bank_movements m on m.bank_account_id = b.id
   where m.id = v_ids[1];
  perform private.log_audit(p_company_id, v_actor, 'PROCESS', 'bank_account', v_account.id,
    'Banco Aula ' || v_account.number,
    format('Procesó %s del Banco Aula: %s',
           case when cardinality(v_ids) = 1 then 'la orden' else cardinality(v_ids) || ' órdenes' end, v_summary));
  return jsonb_build_object('processed', cardinality(v_ids));
end;
$$;

-- ------------------------------------------------------------------ Lecturas

-- La cuenta de la empresa en el Banco Aula (el homebanking y la bandeja del banco): el saldo según el
-- banco al lado del de libros, lo pendiente y lo procesado con el saldo de cada momento. null si la
-- empresa no tiene cuenta (bankAccountView).
create function public.bank_account_view(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_account public.bank_accounts;
  v_ledger public.accounts;
  v_balance numeric;
begin
  perform private.require_read(p_company_id, 'bank.read');
  select * into v_account from public.bank_accounts b where b.company_id = p_company_id and b.is_active
   order by b.created_at limit 1;
  if not found then
    return null;
  end if;
  select * into v_ledger from public.accounts a where a.id = v_account.ledger_account_id;
  select coalesce(sum(case when m.direction = 'CREDITO' then m.amount else -m.amount end), 0) into v_balance
    from public.bank_movements m where m.bank_account_id = v_account.id and m.status = 'PROCESADO';
  return jsonb_build_object(
    'account', jsonb_build_object(
      'id', v_account.id, 'number', v_account.number, 'bank_key', v_account.bank_key, 'alias', v_account.alias,
      'opened_on', v_account.opened_on, 'overdraft_limit', v_account.overdraft_limit,
      'ledger', jsonb_build_object('id', v_ledger.id, 'code', v_ledger.code, 'name', v_ledger.name)),
    'mode', private.bank_mode(p_company_id),
    'balance', v_balance,
    'book_balance', private.account_balance(v_ledger.id),
    'pending', coalesce((
      select jsonb_agg(private.bank_movement_row(p_company_id, m, null) order by m.seq)
        from public.bank_movements m where m.bank_account_id = v_account.id and m.status = 'PENDIENTE'), '[]'),
    'movements', coalesce((
      select jsonb_agg(private.bank_movement_row(p_company_id, x.m, x.balance)
                       order by (x.m).processed_on desc, (x.m).transaction_number collate "C" desc nulls last)
        from (select m, sum(case when m.direction = 'CREDITO' then m.amount else -m.amount end)
                          over (order by m.processed_on, m.transaction_number collate "C" nulls first
                                rows between unbounded preceding and current row) as balance
                from public.bank_movements m
               where m.bank_account_id = v_account.id and m.status = 'PROCESADO') x), '[]'));
end;
$$;

-- Una fila de la cuenta: la operación de la empresa sólo si quien mira la puede leer (BankMovementRow).
create function private.bank_movement_row(p_company uuid, p_m public.bank_movements, p_balance numeric)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_m.id, 'seq', p_m.seq, 'origin', p_m.origin, 'direction', p_m.direction, 'amount', p_m.amount,
    'concept', p_m.concept, 'status', p_m.status, 'received_on', p_m.received_on, 'processed_on', p_m.processed_on,
    'transaction_number', p_m.transaction_number,
    'processed_by_name', case when p_m.processed_by is not null then private.full_name(p_m.processed_by) end,
    'ordered_by_name', case when p_m.ordered_by is not null then private.full_name(p_m.ordered_by) end,
    'own', coalesce(p_m.ordered_by = (select auth.uid()), false),
    'source', (select jsonb_build_object('id', d.id, 'display_number', d.display_number, 'path', private.doc_path(d.id))
                 from public.documents d join public.document_types dt on dt.code = d.doc_type
                where d.id = p_m.source_document_id and private.has_permission(p_company, dt.resource || '.read')),
    'balance', p_balance)
$$;

grant execute on function public.bank_orders_process(uuid, uuid[]) to authenticated;
grant execute on function public.bank_account_view(uuid) to authenticated;

-- ------------------------------------------------------------------ Funciones comunes que cambian

-- Igual que antes, y además el Banco Aula: un asiento manual que mueve el banco le manda sus
-- órdenes y un contraasiento retira o revierte las del asiento que anula (postEntry).
create or replace function private.post_journal_entry(p_doc public.documents, p_actor private.actor default null, p_summary text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
  v_has_debit boolean;
  v_has_credit boolean;
  v_debit numeric;
  v_credit numeric;
  v_bad public.accounts;
  v_period public.fiscal_periods;
  v_last_number int;
  v_last_date date;
  v_number int;
  v_origin text;
begin
  if not exists (
    select 1 from public.document_transitions t
     where t.doc_type = p_doc.doc_type and t.from_status = p_doc.status and t.action = 'CONFIRM'
  ) then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('%s está en estado "%s" y no admite esta acción.', p_doc.display_number, private.status_label(p_doc.doc_type, p_doc.status)));
  end if;
  select count(*), bool_or(l.debit > 0), bool_or(l.credit > 0), coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0)
    into v_count, v_has_debit, v_has_credit, v_debit, v_credit
    from public.journal_entry_lines l where l.document_id = p_doc.id;
  if v_count < 2 or not coalesce(v_has_debit, false) or not coalesce(v_has_credit, false) then
    perform private.raise_business_error('ASIENTO_INCOMPLETO', 'Un asiento tiene al menos una cuenta al debe y otra al haber.',
      'En la partida doble, todo hecho económico afecta como mínimo a dos cuentas.');
  end if;
  select a.* into v_bad
    from public.journal_entry_lines l join public.accounts a on a.id = l.account_id
   where l.document_id = p_doc.id and not (a.is_active and a.is_imputable)
   order by l.line_no limit 1;
  if found then
    perform private.raise_business_error('DATO_INVALIDO',
      format('La cuenta %s %s no admite movimientos: corregí el borrador.', v_bad.code, v_bad.name));
  end if;
  if v_debit <> v_credit then
    perform private.raise_business_error('ASIENTO_DESBALANCEADO',
      format('El asiento no balancea: el debe suma %s y el haber %s (diferencia %s).',
             private.format_money(v_debit), private.format_money(v_credit), private.format_money(abs(v_debit - v_credit))),
      'En la partida doble, lo que se debita tiene que ser igual a lo que se acredita.');
  end if;
  if p_doc.document_date > private.business_date(p_doc.company_id) then
    perform private.raise_business_error('FECHA_INVALIDA', 'La fecha del asiento no puede ser posterior a hoy.');
  end if;
  select * into v_period from public.fiscal_periods p
   where p.company_id = p_doc.company_id and p_doc.document_date between p.start_date and p.end_date;
  if not found then
    perform private.raise_business_error('SIN_EJERCICIO',
      format('No hay un ejercicio abierto que incluya el %s.', to_char(p_doc.document_date, 'DD/MM/YYYY')),
      'El docente abre los ejercicios en "Ejercicios y períodos".');
  end if;
  if v_period.status = 'CERRADO' then
    perform private.raise_business_error('PERIODO_CERRADO',
      format('%s está cerrado: no se registran asientos en ese mes.', v_period.name),
      'Si hace falta, el docente puede reabrir el período.');
  end if;
  -- Un número por vez en cada ejercicio: la fila del ejercicio queda bloqueada hasta el final.
  perform 1 from public.fiscal_years y where y.id = v_period.fiscal_year_id for update;
  select je.entry_number, d.document_date into v_last_number, v_last_date
    from public.journal_entries je join public.documents d on d.id = je.document_id
   where je.company_id = p_doc.company_id and je.fiscal_year_id = v_period.fiscal_year_id and je.entry_number is not null
   order by je.entry_number desc limit 1;
  if v_last_number is not null and p_doc.document_date < v_last_date then
    perform private.raise_business_error('FECHA_INVALIDA',
      format('El libro diario es correlativo: el último asiento registrado (N.º %s) es del %s. Usá esa fecha o una posterior.',
             v_last_number, to_char(v_last_date, 'DD/MM/YYYY')),
      'En un libro encuadernado no se puede intercalar un asiento entre dos ya registrados.');
  end if;
  v_number := coalesce(v_last_number, 0) + 1;
  perform private.transition_document(p_doc.id, 'CONFIRM', p_actor => p_actor, p_summary => coalesce(
    replace(p_summary, '{n}', v_number::text),
    format('Registró %s como asiento N.º %s del libro diario', p_doc.display_number, v_number)));
  update public.journal_entries
     set fiscal_year_id = v_period.fiscal_year_id, entry_number = v_number, posted_at = now()
   where document_id = p_doc.id
  returning origin into v_origin;
  -- El Banco Aula (Fase 8a): un asiento manual que mueve el banco es una orden; un contraasiento
  -- retira o revierte las del asiento que anula. Los automáticos las mandan desde post_event.
  if v_origin = 'MANUAL' then
    perform private.bank_send_orders(p_doc, p_doc);
  elsif v_origin = 'CONTRAASIENTO' then
    perform private.bank_reverse_orders(p_doc);
  end if;
end;
$$;

-- Igual que antes, y además las órdenes al banco del asiento automático, con su operación (postEvent).
create or replace function private.post_event(
  p_actor private.actor,
  p_source public.documents,
  p_event text,
  p_description text,
  p_amounts jsonb
)
returns public.documents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_amount jsonb;
  v_debit numeric;
  v_credit numeric;
  v_account public.accounts;
  v_accounts uuid[] := '{}';
  v_debits numeric[] := '{}';
  v_credits numeric[] := '{}';
  v_found int;
  v_i int;
  v_lines jsonb := '[]';
  v_entry public.documents;
begin
  for v_amount in select * from jsonb_array_elements(p_amounts) loop
    v_debit := round(coalesce((v_amount ->> 'debit')::numeric, 0), 2);
    v_credit := round(coalesce((v_amount ->> 'credit')::numeric, 0), 2);
    continue when v_debit = 0 and v_credit = 0;
    if v_amount ? 'account_id' then
      v_account := private.account_for(p_source.company_id, v_amount ->> 'account_id');
    else
      v_account := private.rule_account(p_source.company_id, p_event, v_amount ->> 'key');
    end if;
    v_found := null;
    for v_i in 1 .. coalesce(array_length(v_accounts, 1), 0) loop
      if v_accounts[v_i] = v_account.id and (v_debits[v_i] > 0) = (v_debit > 0) then
        v_found := v_i;
        exit;
      end if;
    end loop;
    if v_found is null then
      v_accounts := v_accounts || v_account.id;
      v_debits := v_debits || v_debit;
      v_credits := v_credits || v_credit;
    else
      v_debits[v_found] := v_debits[v_found] + v_debit;
      v_credits[v_found] := v_credits[v_found] + v_credit;
    end if;
  end loop;
  for v_i in 1 .. coalesce(array_length(v_accounts, 1), 0) loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_accounts[v_i], 'debit', v_debits[v_i], 'credit', v_credits[v_i], 'notes', ''));
  end loop;
  v_entry := private.new_journal_entry(p_source.company_id, p_actor, private.business_date(p_source.company_id),
    p_description, 'AUTOMATICO', null, v_lines);
  perform private.post_journal_entry(v_entry, p_actor,
    format('Registró %s, asiento automático N.º {n} de %s', v_entry.display_number, p_source.display_number));
  perform private.link_documents(p_source.company_id, p_source.id, v_entry.id);
  perform private.bank_send_orders(p_source, v_entry);
  return v_entry;
end;
$$;

-- Igual que antes, y además quién opera el Banco Aula: al volver al sistema, el banco procesa lo
-- pendiente con la fecha del día (cmdUpdateCompanySettings).
create or replace function public.company_update_settings(p_company_id uuid, p_settings jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_supervisor(p_company_id);
  v_before jsonb;
  v_after jsonb;
  v_rates jsonb;
  v_key text;
  v_value jsonb;
begin
  select c.settings into v_before from public.companies c where c.id = p_company_id for update;
  select v_before || coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into v_after
    from jsonb_each(p_settings)
   where key in ('sod_enabled', 'allow_negative_stock') and jsonb_typeof(value) = 'boolean';
  if jsonb_typeof(p_settings -> 'payroll') = 'object' then
    v_rates := coalesce(v_before -> 'payroll', '{}');
    foreach v_key in array array['seniority_pct', 'attendance_pct', 'retirement_pct', 'pami_pct', 'health_pct',
                                  'employer_pct'] loop
      v_value := p_settings -> 'payroll' -> v_key;
      continue when v_value is null;
      if jsonb_typeof(v_value) <> 'number' or (v_value #>> '{}')::numeric < 0 or (v_value #>> '{}')::numeric > 100
         or round((v_value #>> '{}')::numeric, 2) <> (v_value #>> '{}')::numeric then
        perform private.raise_business_error('DATO_INVALIDO',
          'Los porcentajes de la liquidación van de 0 a 100, con hasta 2 decimales.');
      end if;
      v_rates := v_rates || jsonb_build_object(v_key, v_value);
    end loop;
    v_after := v_after || jsonb_build_object('payroll', v_rates);
  end if;
  if p_settings ? 'iibb_pct' then
    v_value := p_settings -> 'iibb_pct';
    if jsonb_typeof(v_value) <> 'number' or (v_value #>> '{}')::numeric < 0 or (v_value #>> '{}')::numeric > 100
       or round((v_value #>> '{}')::numeric, 2) <> (v_value #>> '{}')::numeric then
      perform private.raise_business_error('DATO_INVALIDO',
        'La alícuota de ingresos brutos va de 0 a 100, con hasta 2 decimales.');
    end if;
    v_after := v_after || jsonb_build_object('iibb_pct', v_value);
  end if;
  if p_settings ? 'bank_mode' then
    if coalesce(p_settings ->> 'bank_mode', '') not in ('AUTOMATICO', 'ESTUDIANTES') then
      perform private.raise_business_error('DATO_INVALIDO', 'Elegí quién opera el Banco Aula.');
    end if;
    v_after := v_after || jsonb_build_object('bank_mode', p_settings -> 'bank_mode');
  end if;
  update public.companies set settings = v_after where id = p_company_id;
  -- Al volver al sistema, el banco procesa lo pendiente con la fecha del día.
  if coalesce(v_after ->> 'bank_mode', 'AUTOMATICO') = 'AUTOMATICO'
     and exists (select 1 from public.bank_movements m where m.company_id = p_company_id and m.status = 'PENDIENTE') then
    perform private.bank_settle(p_company_id, array(
      select m.id from public.bank_movements m
       where m.company_id = p_company_id and m.status = 'PENDIENTE' order by m.seq));
  end if;
  perform private.log_audit(p_company_id, v_actor, 'SETTINGS', 'company', p_company_id,
    (select c.legal_name from public.companies c where c.id = p_company_id),
    case when jsonb_typeof(p_settings -> 'payroll') = 'object'
      then 'Cambió los porcentajes de la liquidación de sueldos'
      when p_settings ? 'iibb_pct' then 'Cambió la alícuota de ingresos brutos'
      when p_settings ? 'bank_mode' then 'Cambió quién opera el Banco Aula: '
        || case v_after ->> 'bank_mode' when 'AUTOMATICO' then 'lo opera el sistema' else 'lo opera Tesorería' end
      else 'Cambió la configuración de control interno de la empresa' end,
    null, null, null,
    private.diff(v_before, v_after, array['sod_enabled', 'allow_negative_stock', 'payroll', 'iibb_pct', 'bank_mode']));
end;
$$;

-- Igual que antes, y además la empresa del curso abre su cuenta en el Banco Aula con la apertura
-- (cmdCreateCompanyFromTemplate).
create or replace function public.company_create_from_template(p_course_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_active_user();
  v_template public.companies;
  v_course public.courses;
  v_id uuid;
  v_slug text;
begin
  if private.current_app_role() not in ('DOCENTE', 'SUPERADMIN') then
    perform private.raise_business_error('SIN_PERMISO', 'Sólo un docente puede crear la empresa simulada de su curso.');
  end if;
  select * into v_template from public.companies c where c.is_template and c.status = 'ACTIVA' order by c.created_at limit 1;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'No hay una empresa plantilla disponible.');
  end if;
  select * into v_course from public.courses c where c.id = p_course_id;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el curso para el que se crea la empresa.');
  end if;
  v_slug := private.unique_slug(private.slugify(format('%s %s %s', v_template.trade_name, v_course.name, v_course.academic_year)));
  v_id := private.clone_company(v_template.id, v_course.id, v_slug, v_uid);
  perform private.log_audit(v_id, private.actor_for(v_id), 'CREATE', 'company', v_id, v_template.legal_name,
    format('Creó la empresa para %s %s a partir de la plantilla %s', v_course.name, v_course.academic_year, v_template.legal_name));
  perform private.copy_initial_stock(v_template.id, v_id);
  perform private.start_accounting(v_id);
  perform private.bank_open_account(v_id);
  return jsonb_build_object('id', v_id, 'slug', v_slug);
end;
$$;

-- Igual que antes, y además la tarea del banco lleva a su bandeja (listTasks).
create or replace function private.task_items(p_company uuid, p_all boolean, p_include_closed boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select (select auth.uid()) as uid, array(select private.my_role_codes(p_company)) as roles
  )
  select coalesce(jsonb_agg(to_jsonb(t) || jsonb_build_object(
           'mine', x.mine,
           'document_label', d.display_number,
           'document_type', d.doc_type,
           'path', case when d.id is not null then private.doc_path(d.id)
                        when t.task_type = 'REPONER_STOCK' then '/e/' || c.slug || '/stock'
                        when t.task_type = 'PROCESAR_BANCO' then '/e/' || c.slug || '/pagos/banco-aula/bandeja' end,
           'assignee_label', case when t.assigned_user_id is not null then private.full_name(t.assigned_user_id)
                                  when t.assigned_role is not null then (select r.name from public.roles r where r.code = t.assigned_role)
                                  else '—' end,
           'claimed_by_name', case when t.claimed_by is not null then private.full_name(t.claimed_by) end,
           'completed_by_name', case when t.completed_by is not null then private.full_name(t.completed_by) end)
         order by t.status = 'EN_CURSO' desc, t.created_at desc), '[]')
    from public.tasks t
    cross join me
    cross join lateral (
      select coalesce(t.assigned_user_id = me.uid, false) or coalesce(t.assigned_role = any (me.roles), false) as mine
    ) x
    join public.companies c on c.id = t.company_id
    left join public.documents d on d.id = t.document_id
   where t.company_id = p_company
     and p_company in (select private.my_companies()) -- sólo quien participa en la empresa (o soporte)
     and (p_include_closed or t.status in ('PENDIENTE', 'EN_CURSO'))
     and (x.mine or p_all)
$$;
