-- 15. Contabilidad (Fase 2, docs/FASE_2_CONTABILIDAD.md): plan de cuentas,
-- ejercicios y períodos, asientos por partida doble y libros contables.
-- Traducción de la sección "Contabilidad" de src/lib/mock/engine.ts y de sus
-- lecturas en queries.ts, con los mismos mensajes y la misma forma de datos:
-- supabase/tests/commands.test.ts y reads.test.ts comparan ambos lados.
--
-- Los datos del plan de cuentas básico y de la apertura están en la migración
-- generada siguiente (private.insert_base_chart, private.opening_amounts).

-- ------------------------------------------------------------------ Tablas

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  code text not null check (code ~ '^[1-5](\.[1-9](\.[0-9]{2}(\.[0-9]{2})?)?)?$'),
  name text not null check (length(trim(name)) >= 3),
  account_type text not null
    check (account_type in ('ACTIVO', 'PASIVO', 'PATRIMONIO_NETO', 'RESULTADO_POSITIVO', 'RESULTADO_NEGATIVO')),
  normal_side text not null check (normal_side in ('DEBE', 'HABER')), -- al revés del tipo en las regularizadoras
  level int not null check (level between 1 and 4),
  is_imputable boolean not null, -- sólo el nivel 4 recibe asientos
  description text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  unique (company_id, code),
  unique (company_id, id),
  check (level = array_length(string_to_array(code, '.'), 1)),
  check (is_imputable = (level = 4))
);

create table public.fiscal_years (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  start_date date not null,
  end_date date not null,
  created_at timestamptz not null default now(),
  unique (company_id, start_date),
  unique (company_id, id),
  check (end_date > start_date)
);

create table public.fiscal_periods (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  fiscal_year_id uuid not null,
  number int not null check (number between 1 and 12),
  name text not null,
  start_date date not null,
  end_date date not null,
  status text not null default 'ABIERTO' check (status in ('ABIERTO', 'CERRADO')),
  closed_by uuid,
  closed_at timestamptz,
  unique (fiscal_year_id, number),
  unique (company_id, id),
  foreign key (company_id, fiscal_year_id) references public.fiscal_years (company_id, id) on delete cascade,
  check ((status = 'CERRADO') = (closed_at is not null))
);
create index fiscal_periods_company_dates_idx on public.fiscal_periods (company_id, start_date);

-- Cabecera del asiento: 1 a 1 con documents (tipo JOURNAL_ENTRY).
create table public.journal_entries (
  document_id uuid primary key,
  doc_type text not null default 'JOURNAL_ENTRY' check (doc_type = 'JOURNAL_ENTRY'),
  company_id uuid not null,
  description text not null, -- leyenda: qué hecho económico registra
  origin text not null check (origin in ('MANUAL', 'APERTURA', 'CONTRAASIENTO', 'AUTOMATICO')),
  fiscal_year_id uuid, -- se asignan al registrarlo en el libro diario
  entry_number int,
  posted_at timestamptz,
  reverses_id uuid, -- en un contraasiento, el asiento que anula
  unique (company_id, document_id),
  unique (fiscal_year_id, entry_number), -- numeración correlativa sin repetidos
  check ((entry_number is null) = (fiscal_year_id is null) and (entry_number is null) = (posted_at is null)),
  foreign key (company_id, document_id, doc_type) references public.documents (company_id, id, doc_type) on delete cascade,
  foreign key (company_id, fiscal_year_id) references public.fiscal_years (company_id, id),
  foreign key (company_id, reverses_id) references public.documents (company_id, id)
);
create index journal_entries_reverses_idx on public.journal_entries (reverses_id);

create table public.journal_entry_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  document_id uuid not null,
  line_no int not null,
  account_id uuid not null,
  debit numeric(14, 2) not null default 0 check (debit >= 0),
  credit numeric(14, 2) not null default 0 check (credit >= 0),
  notes text not null default '',
  unique (document_id, line_no),
  unique (company_id, id),
  check ((debit > 0) <> (credit > 0)), -- cada línea va de un solo lado
  foreign key (company_id, document_id) references public.journal_entries (company_id, document_id) on delete cascade,
  foreign key (company_id, account_id) references public.accounts (company_id, id)
);
create index journal_entry_lines_account_idx on public.journal_entry_lines (account_id);

-- Un asiento registrado no se toca: se anula con un contraasiento (invariante del libro diario).
create function private.forbid_posted_entry_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from public.journal_entries je where je.document_id = old.document_id and je.entry_number is not null) then
    perform private.raise_business_error('INMUTABLE', 'Un asiento registrado no se modifica ni se borra: se anula con un contraasiento.');
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger journal_entry_lines_posted before update or delete on public.journal_entry_lines
  for each row execute function private.forbid_posted_entry_change();

create trigger accounts_audit before insert or update on public.accounts
  for each row execute function private.set_audit_fields();

do $$
declare
  t text;
begin
  foreach t in array array['accounts', 'fiscal_years', 'fiscal_periods', 'journal_entries', 'journal_entry_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format(
      'create trigger %I before update on public.%I for each row execute function private.prevent_company_change()',
      t || '_same_company', t
    );
  end loop;
end;
$$;

create policy accounts_select on public.accounts for select to authenticated
  using (company_id in (select private.companies_with_permission('account.read')));
create policy fiscal_years_select on public.fiscal_years for select to authenticated
  using (company_id in (select private.companies_with_permission('ledger.read')));
create policy fiscal_periods_select on public.fiscal_periods for select to authenticated
  using (company_id in (select private.companies_with_permission('ledger.read')));
create policy journal_entries_select on public.journal_entries for select to authenticated
  using (company_id in (select private.companies_with_permission('journal_entry.read')));
create policy journal_entry_lines_select on public.journal_entry_lines for select to authenticated
  using (company_id in (select private.companies_with_permission('journal_entry.read')));

-- ------------------------------------------------------------------ Utilidades

-- 'aaaa-mm-dd' → fecha; null si no es una fecha válida.
create function private.parse_date(p_text text)
returns date
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_text is null or p_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return null;
  end if;
  return p_text::date;
exception when others then
  return null;
end;
$$;

-- El tipo sale de la clase (primer dígito del código).
create function private.account_type_of(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case left(p_code, 1)
    when '1' then 'ACTIVO' when '2' then 'PASIVO' when '3' then 'PATRIMONIO_NETO'
    when '4' then 'RESULTADO_POSITIVO' when '5' then 'RESULTADO_NEGATIVO'
  end
$$;

-- Saldo normal: deudor para activo y pérdidas; al revés en las regularizadoras (normalSideOf).
create function private.normal_side_of(p_type text, p_contra boolean)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when (p_type in ('ACTIVO', 'RESULTADO_NEGATIVO')) <> coalesce(p_contra, false) then 'DEBE' else 'HABER' end
$$;

create function private.parent_code(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$ select regexp_replace(p_code, '\.[^.]+$', '') $$;

-- Cuenta de la empresa (getAccount); el id llega como texto desde el pedido.
create function private.account_for(p_company uuid, p_account text)
returns public.accounts
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_account public.accounts;
begin
  select * into v_account from public.accounts a where a.company_id = p_company and a.id::text = p_account;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'La cuenta no existe en esta empresa.');
  end if;
  return v_account;
end;
$$;

-- Saldo (debe − haber) de una cuenta según los asientos del libro diario (accountBalance).
create function private.account_balance(p_account uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(l.debit - l.credit), 0)
    from public.journal_entry_lines l
    join public.journal_entries je on je.document_id = l.document_id and je.entry_number is not null
   where l.account_id = p_account
$$;

-- Ejercicio de un año calendario con sus doce períodos mensuales, abiertos.
create function private.create_fiscal_year(p_company uuid, p_year int)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_months text[] := array['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre',
                           'Octubre', 'Noviembre', 'Diciembre'];
begin
  insert into public.fiscal_years (company_id, name, start_date, end_date)
  values (p_company, 'Ejercicio ' || p_year, make_date(p_year, 1, 1), make_date(p_year, 12, 31))
  returning id into v_id;
  insert into public.fiscal_periods (company_id, fiscal_year_id, number, name, start_date, end_date)
  select p_company, v_id, m, v_months[m] || ' ' || p_year, make_date(p_year, m, 1),
         (make_date(p_year, m, 1) + interval '1 month' - interval '1 day')::date
    from generate_series(1, 12) as m;
  return v_id;
end;
$$;

-- ------------------------------------------------------------------ Asientos

-- Controles del borrador (validateEntry): puede quedar desbalanceado, pero cada
-- línea tiene que ser válida. Devuelve [{account_id, debit, credit, notes}].
create function private.validate_journal_entry(p_company uuid, p_input jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lines jsonb;
  v_line jsonb;
  v_account public.accounts;
  v_debit numeric;
  v_credit numeric;
  v_i int := 0;
  v_result jsonb := '[]';
begin
  if length(trim(coalesce(p_input ->> 'description', ''))) < 3 then
    perform private.raise_business_error('DATO_INVALIDO', 'Escribí la leyenda del asiento: qué hecho económico registra.');
  end if;
  if private.parse_date(p_input ->> 'document_date') is null then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá la fecha del asiento.');
  end if;
  select coalesce(jsonb_agg(l order by ord), '[]'::jsonb) into v_lines
    from jsonb_array_elements(coalesce(p_input -> 'lines', '[]'::jsonb)) with ordinality as x (l, ord)
   where nullif(l ->> 'account_id', '') is not null
      or coalesce((l ->> 'debit')::numeric, 0) <> 0
      or coalesce((l ->> 'credit')::numeric, 0) <> 0;
  if jsonb_array_length(v_lines) = 0 then
    perform private.raise_business_error('DATO_INVALIDO', 'Agregá al menos una línea con cuenta e importe.');
  end if;
  if jsonb_array_length(v_lines) > 40 then
    perform private.raise_business_error('DATO_INVALIDO', 'Un asiento admite hasta 40 líneas.');
  end if;
  for v_line in select * from jsonb_array_elements(v_lines) loop
    v_i := v_i + 1;
    if nullif(v_line ->> 'account_id', '') is null then
      perform private.raise_business_error('DATO_INVALIDO', format('Elegí la cuenta de la línea %s.', v_i));
    end if;
    v_account := private.account_for(p_company, v_line ->> 'account_id');
    if not v_account.is_imputable then
      perform private.raise_business_error('DATO_INVALIDO',
        format('%s %s es un rubro: agrupa otras cuentas. Elegí una cuenta imputable (de nivel 4).', v_account.code, v_account.name));
    end if;
    if not v_account.is_active then
      perform private.raise_business_error('DATO_INVALIDO', format('La cuenta %s %s está desactivada.', v_account.code, v_account.name));
    end if;
    v_debit := (v_line ->> 'debit')::numeric;
    v_credit := (v_line ->> 'credit')::numeric;
    if v_debit is null or v_credit is null or v_debit < 0 or v_credit < 0
       or round(v_debit, 2) <> v_debit or round(v_credit, 2) <> v_credit then
      perform private.raise_business_error('DATO_INVALIDO',
        format('Los importes de la línea %s deben ser positivos y tener hasta 2 decimales.', v_i));
    end if;
    if v_debit > 0 and v_credit > 0 then
      perform private.raise_business_error('DATO_INVALIDO',
        format('La línea %s tiene importe al debe y al haber: cada línea va de un solo lado.', v_i));
    end if;
    if not (v_debit > 0 or v_credit > 0) then
      perform private.raise_business_error('DATO_INVALIDO', format('Indicá el importe de la línea %s.', v_i));
    end if;
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'account_id', v_account.id, 'debit', v_debit, 'credit', v_credit, 'notes', trim(coalesce(v_line ->> 'notes', ''))));
  end loop;
  return v_result;
end;
$$;

create function private.write_journal_lines(p_doc public.documents, p_lines jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.journal_entry_lines where document_id = p_doc.id;
  insert into public.journal_entry_lines (company_id, document_id, line_no, account_id, debit, credit, notes)
  select p_doc.company_id, p_doc.id, ord::int, (l ->> 'account_id')::uuid, (l ->> 'debit')::numeric,
         (l ->> 'credit')::numeric, coalesce(l ->> 'notes', '')
    from jsonb_array_elements(p_lines) with ordinality as x (l, ord);
  update public.documents d set subtotal = t.total, total = t.total
    from (select coalesce(sum((l ->> 'debit')::numeric), 0) as total from jsonb_array_elements(p_lines) as l) as t
   where d.id = p_doc.id;
end;
$$;

-- Asiento nuevo en borrador, con su auditoría (newEntry).
create function private.new_journal_entry(
  p_company uuid,
  p_actor private.actor,
  p_date date,
  p_description text,
  p_origin text,
  p_reverses uuid,
  p_lines jsonb
)
returns public.documents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_n int := jsonb_array_length(p_lines);
begin
  v_doc := private.new_document(p_company, 'JOURNAL_ENTRY', p_actor);
  update public.documents d set document_date = p_date where d.id = v_doc.id returning * into v_doc;
  insert into public.journal_entries (document_id, company_id, description, origin, reverses_id)
  values (v_doc.id, p_company, p_description, p_origin, p_reverses);
  perform private.write_journal_lines(v_doc, p_lines);
  perform private.log_audit(p_company, p_actor, 'CREATE', 'journal_entry', v_doc.id, v_doc.display_number,
    format('Creó %s (%s línea%s)', v_doc.display_number, v_n, case when v_n = 1 then '' else 's' end), v_doc.id, null, 'BORRADOR');
  select * into v_doc from public.documents d where d.id = v_doc.id;
  return v_doc;
end;
$$;

-- Registra el asiento en el libro diario (postEntry): partida doble, cuentas
-- activas, período abierto y fecha correlativa; le asigna el número del
-- ejercicio. p_actor sólo para cargas del sistema; p_summary con {n} = número.
create function private.post_journal_entry(p_doc public.documents, p_actor private.actor default null, p_summary text default null)
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
   where document_id = p_doc.id;
end;
$$;

create function public.je_create(p_company_id uuid, p_input jsonb, p_confirm boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'journal_entry.create');
  v_lines jsonb := private.validate_journal_entry(p_company_id, p_input);
  v_doc public.documents;
begin
  v_doc := private.new_journal_entry(p_company_id, v_actor, (p_input ->> 'document_date')::date,
    trim(p_input ->> 'description'), 'MANUAL', null, v_lines);
  if p_confirm then
    perform private.post_journal_entry(v_doc);
  else
    perform private.open_tasks_for_status(v_doc.id, v_actor);
  end if;
  return private.created_result(v_doc.id);
end;
$$;

create function public.je_update(p_document_id uuid, p_input jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_actor private.actor;
  v_lines jsonb;
  v_before jsonb;
  v_after jsonb;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'JOURNAL_ENTRY');
  v_actor := private.require_permission(v_doc.company_id, 'journal_entry.update');
  if v_doc.status <> 'BORRADOR' then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('%s ya no es un borrador: no se modifica. Si tiene un error, se anula con un contraasiento.', v_doc.display_number));
  end if;
  v_lines := private.validate_journal_entry(v_doc.company_id, p_input);
  select jsonb_build_object('document_date', d.document_date, 'description', je.description, 'total', d.total) into v_before
    from public.documents d join public.journal_entries je on je.document_id = d.id where d.id = v_doc.id;
  update public.documents set document_date = (p_input ->> 'document_date')::date where id = v_doc.id;
  update public.journal_entries set description = trim(p_input ->> 'description') where document_id = v_doc.id;
  perform private.write_journal_lines(v_doc, v_lines);
  select jsonb_build_object('document_date', d.document_date, 'description', je.description, 'total', d.total) into v_after
    from public.documents d join public.journal_entries je on je.document_id = d.id where d.id = v_doc.id;
  perform private.log_audit(v_doc.company_id, v_actor, 'UPDATE', 'journal_entry', v_doc.id, v_doc.display_number,
    format('Modificó %s', v_doc.display_number), v_doc.id, null, null,
    private.diff(v_before, v_after, array['document_date', 'description', 'total']));
end;
$$;

create function public.je_confirm(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'JOURNAL_ENTRY');
  perform private.require_permission(v_doc.company_id, 'journal_entry.create');
  perform private.post_journal_entry(v_doc);
end;
$$;

-- El borrador se anula sin más. Un asiento registrado se anula con un
-- contraasiento (mismas cuentas, debe y haber invertidos, fecha de hoy) y los
-- dos quedan en el libro diario (cmdCancelJournalEntry).
create function public.je_cancel(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_je public.journal_entries;
  v_actor private.actor;
  v_comment text := trim(coalesce(p_reason, ''));
  v_lines jsonb;
  v_reversal public.documents;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'JOURNAL_ENTRY');
  if v_doc.status <> 'CONFIRMADO' then
    perform private.transition_document(v_doc.id, 'CANCEL', p_reason);
    return;
  end if;
  v_actor := private.require_permission(v_doc.company_id, 'journal_entry.cancel');
  if length(v_comment) < 3 then
    perform private.raise_business_error('MOTIVO_REQUERIDO', 'Indicá el motivo: queda registrado en el historial del documento.');
  end if;
  select * into v_je from public.journal_entries je where je.document_id = v_doc.id;
  if v_je.origin = 'CONTRAASIENTO' then
    perform private.raise_business_error('DATO_INVALIDO', 'Un contraasiento no se anula. Si hubo un error, registrá el asiento correcto.');
  end if;
  select jsonb_agg(jsonb_build_object('account_id', l.account_id, 'debit', l.credit, 'credit', l.debit, 'notes', l.notes)
                   order by l.line_no)
    into v_lines
    from public.journal_entry_lines l where l.document_id = v_doc.id;
  v_reversal := private.new_journal_entry(v_doc.company_id, v_actor, private.business_date(v_doc.company_id),
    format('Anulación del asiento N.º %s (%s): %s', v_je.entry_number, v_doc.display_number, v_comment),
    'CONTRAASIENTO', v_doc.id, v_lines);
  perform private.post_journal_entry(v_reversal, null,
    format('Registró %s, contraasiento de %s, como asiento N.º {n}', v_reversal.display_number, v_doc.display_number));
  perform private.link_documents(v_doc.company_id, v_doc.id, v_reversal.id);
  perform private.transition_document(v_doc.id, 'CANCEL', v_comment, p_actor => v_actor,
    p_summary => format('Anuló %s con el contraasiento %s — %s', v_doc.display_number, v_reversal.display_number, v_comment));
end;
$$;

-- ------------------------------------------------------------------ Plan de cuentas, ejercicios y períodos

-- Alta de una cuenta imputable dentro de un rubro existente, o cambio de nombre
-- y descripción (cmdSaveAccount). p_input: {id?, code, name, description, is_contra}.
create function public.account_save(p_company_id uuid, p_input jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text := nullif(p_input ->> 'id', '');
  v_actor private.actor;
  v_name text := trim(coalesce(p_input ->> 'name', ''));
  v_description text := trim(coalesce(p_input ->> 'description', ''));
  v_contra boolean := coalesce((p_input ->> 'is_contra')::boolean, false);
  v_code text := trim(coalesce(p_input ->> 'code', ''));
  v_type text;
  v_side text;
  v_account public.accounts;
  v_before jsonb;
  v_changes jsonb;
begin
  v_actor := private.require_permission(p_company_id, case when v_id is null then 'account.create' else 'account.update' end);
  if length(v_name) < 3 then
    perform private.raise_business_error('DATO_INVALIDO', 'Ingresá el nombre de la cuenta.');
  end if;
  if exists (
    select 1 from public.accounts a
     where a.company_id = p_company_id and a.id::text is distinct from v_id
       and private.sort_key(trim(a.name)) = private.sort_key(v_name)
  ) then
    perform private.raise_business_error('DATO_INVALIDO', format('Ya existe una cuenta llamada "%s".', v_name));
  end if;
  if v_id is null then
    if v_code !~ '^[1-5]\.[1-9]\.[0-9]{2}\.[0-9]{2}$' then
      perform private.raise_business_error('DATO_INVALIDO', 'El código de una cuenta nueva tiene cuatro niveles, por ejemplo 1.1.01.05.');
    end if;
    if not exists (select 1 from public.accounts a where a.company_id = p_company_id and a.code = private.parent_code(v_code)) then
      perform private.raise_business_error('DATO_INVALIDO',
        format('No existe el rubro %s: las cuentas nuevas van dentro de un rubro del plan.', private.parent_code(v_code)));
    end if;
    if exists (select 1 from public.accounts a where a.company_id = p_company_id and a.code = v_code) then
      perform private.raise_business_error('DATO_INVALIDO', format('Ya existe la cuenta %s.', v_code));
    end if;
    v_type := private.account_type_of(v_code);
    insert into public.accounts (company_id, code, name, account_type, normal_side, level, is_imputable, description)
    values (p_company_id, v_code, v_name, v_type, private.normal_side_of(v_type, v_contra), 4, true, v_description)
    returning * into v_account;
    perform private.log_audit(p_company_id, v_actor, 'CREATE', 'account', v_account.id, v_account.code || ' ' || v_account.name,
      format('Dio de alta la cuenta %s %s', v_account.code, v_account.name));
    return v_account.id;
  end if;
  v_account := private.account_for(p_company_id, v_id);
  if not v_account.is_imputable then
    perform private.raise_business_error('DATO_INVALIDO', 'Los rubros del plan de cuentas no se modifican.');
  end if;
  v_side := private.normal_side_of(v_account.account_type, v_contra);
  if v_side <> v_account.normal_side and exists (
    select 1 from public.journal_entry_lines l
      join public.journal_entries je on je.document_id = l.document_id and je.entry_number is not null
     where l.account_id = v_account.id
  ) then
    perform private.raise_business_error('DATO_INVALIDO', 'La cuenta ya tiene movimientos: no se puede cambiar si es regularizadora.');
  end if;
  v_before := to_jsonb(v_account);
  update public.accounts set name = v_name, description = v_description, normal_side = v_side
   where id = v_account.id returning * into v_account;
  v_changes := private.diff(v_before, to_jsonb(v_account), array['name', 'description', 'normal_side']);
  if v_changes <> '{}'::jsonb then
    perform private.log_audit(p_company_id, v_actor, 'UPDATE', 'account', v_account.id, v_account.code || ' ' || v_account.name,
      format('Modificó la cuenta %s %s', v_account.code, v_account.name), null, null, null, v_changes);
  end if;
  return v_account.id;
end;
$$;

create function public.account_set_active(p_company_id uuid, p_account_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'account.update');
  v_account public.accounts := private.account_for(p_company_id, p_account_id::text);
  v_balance numeric;
begin
  if not v_account.is_imputable then
    perform private.raise_business_error('DATO_INVALIDO', 'Sólo se desactivan cuentas imputables (de nivel 4).');
  end if;
  if v_account.is_active = p_active then
    return;
  end if;
  v_balance := private.account_balance(v_account.id);
  if not p_active and v_balance <> 0 then
    perform private.raise_business_error('DATO_INVALIDO',
      format('La cuenta %s %s tiene saldo (%s): primero hay que dejarla en cero.', v_account.code, v_account.name,
             private.format_money(abs(v_balance))));
  end if;
  update public.accounts set is_active = p_active where id = v_account.id;
  perform private.log_audit(p_company_id, v_actor, case when p_active then 'ACTIVATE' else 'DEACTIVATE' end, 'account',
    v_account.id, v_account.code || ' ' || v_account.name,
    format('%s la cuenta %s %s', case when p_active then 'Activó' else 'Desactivó' end, v_account.code, v_account.name));
end;
$$;

-- El docente abre un ejercicio nuevo (cmdOpenFiscalYear).
create function public.fiscal_year_open(p_company_id uuid, p_year int)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_supervisor(p_company_id);
  v_current int := extract(year from private.business_date(p_company_id))::int;
  v_id uuid;
begin
  if p_year is null or p_year < 2000 or p_year > v_current + 1 then
    perform private.raise_business_error('DATO_INVALIDO', format('Elegí un año válido, hasta %s.', v_current + 1));
  end if;
  if exists (select 1 from public.fiscal_years y where y.company_id = p_company_id and y.start_date = make_date(p_year, 1, 1)) then
    perform private.raise_business_error('DATO_INVALIDO', format('El ejercicio %s ya existe.', p_year));
  end if;
  v_id := private.create_fiscal_year(p_company_id, p_year);
  perform private.log_audit(p_company_id, v_actor, 'OPEN_FISCAL_YEAR', 'fiscal_year', v_id, 'Ejercicio ' || p_year,
    format('Abrió el ejercicio %s con sus doce períodos mensuales', p_year));
  return v_id;
end;
$$;

-- Contabilidad cierra un mes; sólo el docente lo reabre, con motivo (cmdSetPeriodStatus).
create function public.fiscal_period_set_status(p_company_id uuid, p_period_id uuid, p_status text, p_reason text default '')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period public.fiscal_periods;
  v_closing boolean := p_status = 'CERRADO';
  v_actor private.actor;
  v_comment text := trim(coalesce(p_reason, ''));
begin
  perform private.require_active_user();
  select * into v_period from public.fiscal_periods p where p.id = p_period_id and p.company_id = p_company_id for update;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'El período no existe en esta empresa.');
  end if;
  if p_status is null or p_status not in ('ABIERTO', 'CERRADO') then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá si el período se abre o se cierra.');
  end if;
  if v_closing then
    v_actor := private.require_permission(p_company_id, 'fiscal_period.update');
  else
    v_actor := private.require_supervisor(p_company_id);
  end if;
  if v_period.status = p_status then
    perform private.raise_business_error('DATO_INVALIDO',
      format('%s ya está %s.', v_period.name, case when v_closing then 'cerrado' else 'abierto' end));
  end if;
  if not v_closing and length(v_comment) < 3 then
    perform private.raise_business_error('MOTIVO_REQUERIDO', 'Indicá el motivo de la reapertura: queda registrado en la auditoría.');
  end if;
  update public.fiscal_periods
     set status = p_status,
         closed_by = case when v_closing then (select auth.uid()) end,
         closed_at = case when v_closing then now() end
   where id = v_period.id;
  perform private.log_audit(p_company_id, v_actor, case when v_closing then 'CLOSE_PERIOD' else 'REOPEN_PERIOD' end,
    'fiscal_period', v_period.id, v_period.name,
    format('%s el período %s%s', case when v_closing then 'Cerró' else 'Reabrió' end, v_period.name,
           case when v_comment <> '' then ' — ' || v_comment else '' end));
end;
$$;

-- Contabilidad de una empresa nueva (startAccounting): plan de cuentas básico
-- si no tiene, ejercicio del año en curso y asiento N.º 1 de apertura al 1.º
-- de enero. Los bienes de cambio salen del inventario inicial (así el mayor
-- coincide con el stock); la diferencia va a resultados no asignados.
create function private.start_accounting(p_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_system private.actor := row(null, 'Sistema', 'SISTEMA', null, '—')::private.actor;
  v_year int := extract(year from private.business_date(p_company))::int;
  v_fy public.fiscal_years;
  v_fy_id uuid;
  v_lines jsonb;
  v_doc public.documents;
begin
  if not exists (select 1 from public.accounts a where a.company_id = p_company) then
    perform private.insert_base_chart(p_company);
  end if;
  select * into v_fy from public.fiscal_years y where y.company_id = p_company and y.start_date = make_date(v_year, 1, 1);
  if not found then
    v_fy_id := private.create_fiscal_year(p_company, v_year);
    select * into v_fy from public.fiscal_years y where y.id = v_fy_id;
  end if;
  if exists (select 1 from public.documents d where d.company_id = p_company and d.doc_type = 'JOURNAL_ENTRY') then
    return;
  end if;
  with amounts as (
    select a.id, a.code, o.debit - o.credit as amount
      from private.opening_amounts() as o
      join public.accounts a on a.company_id = p_company and a.code = o.code and a.is_imputable
    union all
    select a.id, a.code, l.quantity_delta * l.unit_cost
      from public.documents d
      join public.stock_adjustments sa on sa.document_id = d.id
      join public.stock_adjustment_lines l on l.document_id = d.id
      join public.products p on p.id = l.product_id
      join public.accounts a on a.company_id = p_company and a.code = private.inventory_account(p.product_type) and a.is_imputable
     where d.company_id = p_company and d.doc_type = 'STOCK_ADJUSTMENT' and d.status = 'CONFIRMADO'
       and sa.reason_code = 'INVENTARIO_INICIAL'
  ),
  balanced as (
    select x.id, x.code, x.amount from amounts x
    union all
    select a.id, a.code, -(select coalesce(sum(x.amount), 0) from amounts x)
      from public.accounts a
     where a.company_id = p_company and a.code = private.opening_balancing_account() and a.is_imputable
  ),
  net as (
    select b.id, b.code, round(sum(b.amount), 2) as net from balanced b group by b.id, b.code
  )
  select jsonb_agg(jsonb_build_object('account_id', n.id, 'debit', greatest(n.net, 0), 'credit', greatest(-n.net, 0), 'notes', '')
                   order by (n.net > 0) desc, n.code collate "C")
    into v_lines
    from net n where n.net <> 0;
  v_doc := private.new_journal_entry(p_company, v_system, v_fy.start_date,
    format('Asiento de apertura del %s: saldos iniciales de la empresa.', lower(v_fy.name)), 'APERTURA', null,
    coalesce(v_lines, '[]'::jsonb));
  perform private.post_journal_entry(v_doc, v_system,
    format('Registró %s, asiento N.º {n} de apertura del ejercicio', v_doc.display_number));
end;
$$;

grant execute on function public.je_create(uuid, jsonb, boolean) to authenticated;
grant execute on function public.je_update(uuid, jsonb) to authenticated;
grant execute on function public.je_confirm(uuid) to authenticated;
grant execute on function public.je_cancel(uuid, text) to authenticated;
grant execute on function public.account_save(uuid, jsonb) to authenticated;
grant execute on function public.account_set_active(uuid, uuid, boolean) to authenticated;
grant execute on function public.fiscal_year_open(uuid, int) to authenticated;
grant execute on function public.fiscal_period_set_status(uuid, uuid, text, text) to authenticated;

-- ------------------------------------------------------------------ Lecturas de Contabilidad

-- Rango de los libros (assertRange).
create function private.book_range(p_from text, p_to text, out date_from date, out date_to date)
language plpgsql
immutable
set search_path = ''
as $$
begin
  date_from := private.parse_date(p_from);
  date_to := private.parse_date(p_to);
  if date_from is null or date_to is null then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá las fechas desde y hasta.');
  end if;
  if date_from > date_to then
    perform private.raise_business_error('DATO_INVALIDO', 'La fecha desde no puede ser posterior a la fecha hasta.');
  end if;
end;
$$;

-- Cuenta con su debe, haber y saldo del libro diario; un rubro suma sus cuentas (AccountRow).
create function private.account_json(p_account public.accounts)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with totals as (
    select coalesce(sum(l.debit), 0) as debit, coalesce(sum(l.credit), 0) as credit
      from public.accounts x
      join public.journal_entry_lines l on l.account_id = x.id
      join public.journal_entries je on je.document_id = l.document_id and je.entry_number is not null
     where x.company_id = p_account.company_id and x.is_imputable
       and (x.id = p_account.id or x.code like p_account.code || '.%')
  )
  select to_jsonb(p_account) || jsonb_build_object(
    'debit', t.debit, 'credit', t.credit, 'balance', t.debit - t.credit,
    'contrary', p_account.is_imputable
                and case when p_account.normal_side = 'DEBE' then t.debit - t.credit < 0 else t.debit - t.credit > 0 end)
    from totals t
$$;

create function public.accounts_list(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'account.read');
  return coalesce((
    select jsonb_agg(private.account_json(a) order by a.code collate "C")
      from public.accounts a where a.company_id = p_company_id
  ), '[]');
end;
$$;

-- Ejercicios del más reciente al más antiguo, con sus meses y asientos (listFiscalYears).
create function public.fiscal_years_list(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'ledger.read');
  return coalesce((
    select jsonb_agg(to_jsonb(y) || jsonb_build_object('periods', (
             select coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object(
                      'closed_by_name', case when p.closed_by is not null then private.full_name(p.closed_by) else '' end,
                      'entries', (
                        select count(*) from public.documents d
                          join public.journal_entries je on je.document_id = d.id and je.entry_number is not null
                         where d.company_id = p.company_id and d.document_date between p.start_date and p.end_date),
                      'drafts', (
                        select count(*) from public.documents d
                         where d.company_id = p.company_id and d.doc_type = 'JOURNAL_ENTRY' and d.status = 'BORRADOR'
                           and d.document_date between p.start_date and p.end_date)
                    ) order by p.number), '[]'::jsonb)
               from public.fiscal_periods p where p.fiscal_year_id = y.id))
           order by y.start_date desc)
      from public.fiscal_years y where y.company_id = p_company_id
  ), '[]');
end;
$$;

-- Libro diario (journalBook): asientos registrados entre dos fechas, en orden
-- correlativo; en cada uno, primero las cuentas del debe.
create function public.journal_book(p_company_id uuid, p_from text, p_to text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from date;
  v_to date;
begin
  perform private.require_read(p_company_id, 'ledger.read');
  select r.date_from, r.date_to into v_from, v_to from private.book_range(p_from, p_to) as r;
  return (
    with posted as (
      select d.id, d.display_number, d.document_date, d.status, d.total, je.entry_number, je.description, je.origin,
             l.line_no, l.debit, l.credit, l.notes, a.code, a.name
        from public.documents d
        join public.journal_entries je on je.document_id = d.id and je.entry_number is not null
        join public.journal_entry_lines l on l.document_id = d.id
        join public.accounts a on a.id = l.account_id
       where d.company_id = p_company_id and d.document_date between v_from and v_to
    ),
    entries as (
      select p.id, p.display_number, p.document_date, p.entry_number, p.description, p.origin, p.status, p.total,
             jsonb_agg(jsonb_build_object('account_code', p.code, 'account_name', p.name, 'debit', p.debit,
                                          'credit', p.credit, 'notes', p.notes)
                       order by (p.debit > 0) desc, p.line_no) as lines
        from posted p
       group by p.id, p.display_number, p.document_date, p.entry_number, p.description, p.origin, p.status, p.total
    )
    select jsonb_build_object(
      'entries', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', e.id, 'display_number', e.display_number, 'path', private.doc_path(e.id), 'entry_number', e.entry_number,
                 'date', e.document_date, 'description', e.description, 'origin', e.origin, 'status', e.status,
                 'lines', e.lines, 'total', e.total)
               order by e.document_date, e.entry_number)
          from entries e), '[]'::jsonb),
      'total_debit', (select coalesce(sum(p.debit), 0) from posted p),
      'total_credit', (select coalesce(sum(p.credit), 0) from posted p)
    )
  );
end;
$$;

-- Libro mayor de una cuenta imputable (ledger): saldo anterior, movimientos con
-- saldo acumulado y saldo final. null si la cuenta no es de la empresa.
create function public.ledger(p_company_id uuid, p_account_id uuid, p_from text, p_to text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from date;
  v_to date;
  v_account public.accounts;
  v_opening numeric;
begin
  perform private.require_read(p_company_id, 'ledger.read');
  select r.date_from, r.date_to into v_from, v_to from private.book_range(p_from, p_to) as r;
  perform private.require_read(p_company_id, 'account.read');
  select * into v_account from public.accounts a where a.company_id = p_company_id and a.id = p_account_id;
  if not found then
    return null;
  end if;
  if not v_account.is_imputable then
    perform private.raise_business_error('DATO_INVALIDO', 'El mayor se consulta por cuenta imputable (de nivel 4).');
  end if;
  select coalesce(sum(l.debit - l.credit), 0) into v_opening
    from public.journal_entry_lines l
    join public.journal_entries je on je.document_id = l.document_id and je.entry_number is not null
    join public.documents d on d.id = l.document_id
   where l.account_id = v_account.id and d.document_date < v_from;
  return (
    with moves as (
      select d.id, d.display_number, je.entry_number, d.document_date, l.line_no, l.debit, l.credit,
             coalesce(nullif(l.notes, ''), je.description) as description
        from public.journal_entry_lines l
        join public.journal_entries je on je.document_id = l.document_id and je.entry_number is not null
        join public.documents d on d.id = l.document_id
       where l.account_id = v_account.id and d.document_date between v_from and v_to
    ),
    running as (
      select m.*, v_opening + sum(m.debit - m.credit) over (
               order by m.document_date, m.entry_number, m.line_no rows between unbounded preceding and current row) as balance
        from moves m
    )
    select jsonb_build_object(
      'account', private.account_json(v_account),
      'opening_balance', v_opening,
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'document_id', r.id, 'display_number', r.display_number, 'path', private.doc_path(r.id),
                 'entry_number', r.entry_number, 'date', r.document_date, 'description', r.description,
                 'debit', r.debit, 'credit', r.credit, 'balance', r.balance)
               order by r.document_date, r.entry_number, r.line_no)
          from running r), '[]'::jsonb),
      'total_debit', (select coalesce(sum(m.debit), 0) from moves m),
      'total_credit', (select coalesce(sum(m.credit), 0) from moves m),
      'closing_balance', v_opening + (select coalesce(sum(m.debit - m.credit), 0) from moves m)
    )
  );
end;
$$;

-- Balance de sumas y saldos de las cuentas con movimientos entre dos fechas (trialBalance).
create function public.trial_balance(p_company_id uuid, p_from text, p_to text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from date;
  v_to date;
begin
  perform private.require_read(p_company_id, 'ledger.read');
  select r.date_from, r.date_to into v_from, v_to from private.book_range(p_from, p_to) as r;
  return (
    with totals as (
      select l.account_id, sum(l.debit) as debit, sum(l.credit) as credit
        from public.journal_entry_lines l
        join public.journal_entries je on je.document_id = l.document_id and je.entry_number is not null
        join public.documents d on d.id = l.document_id
       where d.company_id = p_company_id and d.document_date between v_from and v_to
       group by l.account_id
    ),
    lines as (
      select a.id, a.code, a.name, a.account_type, a.normal_side, t.debit, t.credit, t.debit - t.credit as balance
        from totals t join public.accounts a on a.id = t.account_id
    ),
    sums as (
      select coalesce(sum(x.debit), 0) as debit, coalesce(sum(x.credit), 0) as credit,
             coalesce(sum(greatest(x.balance, 0)), 0) as debit_balance,
             coalesce(sum(greatest(-x.balance, 0)), 0) as credit_balance
        from lines x
    )
    select jsonb_build_object(
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'account_id', x.id, 'code', x.code, 'name', x.name, 'account_type', x.account_type,
                 'debit', x.debit, 'credit', x.credit,
                 'debit_balance', greatest(x.balance, 0), 'credit_balance', greatest(-x.balance, 0),
                 'contrary', case when x.normal_side = 'DEBE' then x.balance < 0 else x.balance > 0 end)
               order by x.code collate "C")
          from lines x), '[]'::jsonb),
      'totals', jsonb_build_object('debit', s.debit, 'credit', s.credit, 'debit_balance', s.debit_balance,
                                   'credit_balance', s.credit_balance),
      'balanced', s.debit = s.credit and s.debit_balance = s.credit_balance
    )
      from sums s
  );
end;
$$;

grant execute on function public.accounts_list(uuid) to authenticated;
grant execute on function public.fiscal_years_list(uuid) to authenticated;
grant execute on function public.journal_book(uuid, text, text) to authenticated;
grant execute on function public.ledger(uuid, uuid, text, text) to authenticated;
grant execute on function public.trial_balance(uuid, text, text) to authenticated;

-- ------------------------------------------------------------------ Documentos: el asiento en las lecturas comunes

-- Asiento contable en el detalle de un documento (journalView): sus líneas van por cuenta.
create function private.journal_view(p_doc public.documents)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'description', je.description,
    'origin', je.origin,
    'entry_number', je.entry_number,
    'fiscal_year_name', (select y.name from public.fiscal_years y where y.id = je.fiscal_year_id),
    'posted_at', je.posted_at,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'account', jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name),
               'debit', l.debit, 'credit', l.credit, 'notes', l.notes)
             order by l.line_no)
        from public.journal_entry_lines l join public.accounts a on a.id = l.account_id
       where l.document_id = p_doc.id), '[]'::jsonb),
    'total_debit', (select coalesce(sum(l.debit), 0) from public.journal_entry_lines l where l.document_id = p_doc.id),
    'total_credit', (select coalesce(sum(l.credit), 0) from public.journal_entry_lines l where l.document_id = p_doc.id),
    'reversed_by', (
      select jsonb_build_object('display_number', d.display_number, 'path', private.doc_path(d.id))
        from public.journal_entries r join public.documents d on d.id = r.document_id
       where r.reverses_id = p_doc.id
       limit 1),
    'reverses', (
      select jsonb_build_object('display_number', d.display_number, 'path', private.doc_path(d.id))
        from public.documents d where d.id = je.reverses_id)
  )
    from public.journal_entries je where je.document_id = p_doc.id
$$;

-- Cabecera común más el detalle de su tipo (T.Document: pr, po, gr, sa o je).
create or replace function private.document_json(p_doc public.documents)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(p_doc)
    || coalesce((
      select jsonb_build_object('pr', jsonb_build_object('needed_by', x.needed_by, 'priority', x.priority, 'reason', x.reason))
        from public.purchase_requisitions x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('po', jsonb_build_object(
               'expected_date', x.expected_date, 'warehouse_id', x.warehouse_id, 'payment_terms_days', x.payment_terms_days,
               'delivery_terms', x.delivery_terms, 'approved_at', x.approved_at, 'sent_at', x.sent_at))
        from public.purchase_orders x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('gr', jsonb_build_object(
               'purchase_order_id', x.purchase_order_id, 'warehouse_id', x.warehouse_id,
               'supplier_delivery_note', x.supplier_delivery_note, 'carrier_name', x.carrier_name, 'received_at', x.received_at))
        from public.goods_receipts x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('sa', jsonb_build_object('warehouse_id', x.warehouse_id, 'reason_code', x.reason_code))
        from public.stock_adjustments x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('je', jsonb_build_object(
               'description', x.description, 'origin', x.origin, 'fiscal_year_id', x.fiscal_year_id,
               'entry_number', x.entry_number, 'posted_at', x.posted_at, 'reverses_id', x.reverses_id))
        from public.journal_entries x where x.document_id = p_doc.id), '{}')
$$;

-- Fila de un listado de documentos (DocumentListItem); en un asiento, el resumen es la leyenda.
create or replace function private.document_item(p_doc public.documents)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with lines as (
    select l.line_no, l.product_id from public.purchase_requisition_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.purchase_order_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.goods_receipt_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.stock_adjustment_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, null::uuid from public.journal_entry_lines l where l.document_id = p_doc.id
  ),
  codes as (
    select array_agg(p.code order by l.line_no) as list, count(*) as n
      from lines l join public.products p on p.id = l.product_id
  )
  select private.document_json(p_doc) || jsonb_build_object(
    'status_info', private.status_info(p_doc.doc_type, p_doc.status),
    'supplier_name', coalesce((select s.legal_name from public.suppliers s where s.id = p_doc.supplier_id), ''),
    'sector_name', coalesce((select s.name from public.sectors s where s.id = p_doc.sector_id), '—'),
    'created_by_name', private.full_name(p_doc.created_by),
    'line_count', (select count(*) from lines),
    'summary', coalesce(
      (select je.description from public.journal_entries je where je.document_id = p_doc.id),
      (select coalesce(array_to_string(c.list[1:3], ', '), '') || case when c.n > 3 then format(' y %s más', c.n - 3) else '' end
         from codes c)),
    'pending_approver', (
      select r.name from public.approval_requests a join public.roles r on r.code = a.approver_role
       where a.document_id = p_doc.id and a.status = 'PENDIENTE'),
    'reference_label', (
      select string_agg(o.display_number, ', ' order by o.display_number collate "C")
        from public.document_links k join public.documents o on o.id = k.from_document_id
       where k.to_document_id = p_doc.id),
    'path', private.doc_path(p_doc.id)
  )
$$;

-- Acciones disponibles para el usuario, con el motivo si está deshabilitada (availableActions).
create or replace function private.available_actions(p_doc public.documents)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_supervisor boolean := private.is_supervisor(p_doc.company_id);
  v_roles text[] := array(select private.my_role_codes(p_doc.company_id));
  v_sod boolean := coalesce((select (c.settings ->> 'sod_enabled')::boolean from public.companies c where c.id = p_doc.company_id), false);
  v_req public.approval_requests;
  v_tr public.document_transitions;
  v_reason text;
  v_result jsonb := '[]';
begin
  select * into v_req from public.approval_requests a where a.document_id = p_doc.id and a.status = 'PENDIENTE';
  for v_tr in
    select * from public.document_transitions t
     where t.doc_type = p_doc.doc_type and t.from_status = p_doc.status and t.action <> 'SYSTEM'
     order by t.sort
  loop
    continue when v_tr.permission_code is null or not private.has_permission(p_doc.company_id, v_tr.permission_code);
    v_reason := null;
    if p_doc.doc_type = 'PURCHASE_ORDER' and v_tr.action in ('APPROVE', 'REJECT') then
      if v_req.id is not null and not v_supervisor and not (v_req.approver_role = any (v_roles)) then
        v_reason := format('Por el monto (%s) la aprueba %s.', private.format_money(v_req.amount),
                           (select r.name from public.roles r where r.code = v_req.approver_role));
      elsif not v_supervisor and v_sod and p_doc.created_by = v_uid then
        v_reason := 'Separación de funciones: no podés aprobar ni rechazar una orden que creaste vos.';
      end if;
    end if;
    if p_doc.doc_type = 'PURCHASE_ORDER' and v_tr.action = 'WITHDRAW' and not v_supervisor
       and p_doc.created_by is distinct from v_uid then
      v_reason := 'Sólo quien creó la orden puede retirarla.';
    end if;
    if p_doc.doc_type = 'PURCHASE_ORDER' and v_tr.action = 'CANCEL'
       and exists (select 1 from public.purchase_order_lines l where l.document_id = p_doc.id and l.qty_received > 0) then
      v_reason := 'Tiene recepciones: usá "Cerrar saldo".';
    end if;
    if p_doc.doc_type = 'PURCHASE_REQUISITION' and v_tr.action in ('SUBMIT', 'CANCEL') and not v_supervisor
       and p_doc.created_by is distinct from v_uid
       and (p_doc.sector_id is null or not exists (
         select 1 from public.company_members m join public.member_roles mr on mr.member_id = m.id
          where m.company_id = p_doc.company_id and m.user_id = v_uid and mr.sector_id = p_doc.sector_id)) then
      v_reason := 'Sólo el sector solicitante puede hacerlo.';
    end if;
    if p_doc.doc_type = 'GOODS_RECEIPT' and p_doc.status = 'CONFIRMADO' and v_tr.action = 'CANCEL' and v_sod
       and not v_supervisor and not ('GERENCIA' = any (v_roles)) and p_doc.created_by = v_uid then
      v_reason := 'Separación de funciones: otro integrante de Depósito o Gerencia debe anularla.';
    end if;
    if p_doc.doc_type = 'JOURNAL_ENTRY' and v_tr.action = 'CANCEL'
       and exists (select 1 from public.journal_entries je where je.document_id = p_doc.id and je.origin = 'CONTRAASIENTO') then
      v_reason := 'Un contraasiento no se anula. Si hubo un error, registrá el asiento correcto.';
    end if;
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'action', v_tr.action, 'label', v_tr.label, 'help', v_tr.help_text, 'tone', v_tr.tone,
      'requires_comment', v_tr.requires_comment, 'enabled', v_reason is null, 'reason', v_reason));
  end loop;
  return v_result;
end;
$$;

-- Quién sigue y qué tiene que hacer (nextStep).
create or replace function private.next_step(p_doc public.documents)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sector text := coalesce((select s.name from public.sectors s where s.id = p_doc.sector_id), 'el sector solicitante');
  v_req public.approval_requests;
  v_rule text;
begin
  case p_doc.doc_type || ':' || p_doc.status
    when 'PURCHASE_REQUISITION:BORRADOR' then
      return jsonb_build_object('who', v_sector,
        'text', 'Completar los ítems, justificar la necesidad y enviar la solicitud a Compras.');
    when 'PURCHASE_REQUISITION:SOLICITADO' then
      return jsonb_build_object('who', 'Compras',
        'text', 'Debe incluir la solicitud en una orden de compra a un proveedor, o rechazarla indicando el motivo.');
    when 'PURCHASE_REQUISITION:ORDENADO_PARCIAL' then
      return jsonb_build_object('who', 'Compras', 'text', 'Resta ordenar el saldo pendiente o cerrarlo con motivo.');
    when 'PURCHASE_REQUISITION:ORDENADO' then
      return jsonb_build_object('who', 'Compras y Depósito',
        'text', 'La necesidad ya está cubierta por órdenes de compra. Seguí su avance en "Flujo documental".');
    when 'PURCHASE_ORDER:BORRADOR' then
      return jsonb_build_object('who', 'Compras',
        'text', 'Revisar proveedor, precios, cantidades y fecha de entrega, y enviar la orden a aprobación.');
    when 'PURCHASE_ORDER:PENDIENTE_APROBACION' then
      select * into v_req from public.approval_requests a where a.document_id = p_doc.id and a.status = 'PENDIENTE';
      select r.description into v_rule from public.approval_rules r where r.id = v_req.rule_id;
      return jsonb_build_object(
        'who', coalesce((select ro.name from public.roles ro where ro.code = v_req.approver_role), 'Aprobador'),
        'text', trim(coalesce(v_rule, '') || ' Quien creó la orden no puede aprobarla: es un control de separación de funciones.'));
    when 'PURCHASE_ORDER:RECHAZADO' then
      return jsonb_build_object('who', 'Compras',
        'text', format('Motivo del rechazo: "%s". Reabrir, corregir y reenviar, o anular la orden.', p_doc.status_reason));
    when 'PURCHASE_ORDER:APROBADO' then
      return jsonb_build_object('who', 'Compras',
        'text', 'Comunicar la orden al proveedor (imprimirla o enviarla) y marcarla como enviada.');
    when 'PURCHASE_ORDER:ENVIADO' then
      return jsonb_build_object('who', 'Depósito',
        'text', 'Cuando llegue la mercadería, controlarla contra esta orden y el remito del proveedor, y registrar la recepción.');
    when 'PURCHASE_ORDER:RECIBIDO_PARCIAL' then
      return jsonb_build_object('who', 'Depósito o Compras',
        'text', 'Falta recibir el saldo. Si no va a llegar, Compras puede cerrar el saldo con motivo.');
    when 'PURCHASE_ORDER:RECIBIDO' then
      return jsonb_build_object('who', 'Próxima fase',
        'text', 'Circuito de compra completo. En la Fase 3 continuará con la factura del proveedor, el pago y el asiento contable.');
    when 'GOODS_RECEIPT:BORRADOR' then
      return jsonb_build_object('who', 'Depósito',
        'text', 'Revisar cantidades contra el remito y confirmar la recepción para que ingrese al stock.');
    when 'GOODS_RECEIPT:CONFIRMADO' then
      return jsonb_build_object('who', '—',
        'text', 'La mercadería ingresó al stock (ver kardex). Compras y el solicitante fueron notificados.');
    when 'STOCK_ADJUSTMENT:BORRADOR' then
      return jsonb_build_object('who', 'Depósito', 'text', 'Revisar y confirmar el ajuste.');
    when 'STOCK_ADJUSTMENT:CONFIRMADO' then
      return jsonb_build_object('who', '—', 'text', 'El ajuste impactó en el stock y quedó documentado.');
    when 'JOURNAL_ENTRY:BORRADOR' then
      return jsonb_build_object('who', 'Contabilidad',
        'text', 'Revisar que las cuentas sean las correctas y que el debe y el haber sumen lo mismo, y registrar el asiento en el libro diario.');
    when 'JOURNAL_ENTRY:CONFIRMADO' then
      return jsonb_build_object('who', '—',
        'text', format('Está en el libro diario con el N.º %s. Si tiene un error, no se corrige: se anula con un contraasiento y se registra el asiento correcto.',
                       (select je.entry_number from public.journal_entries je where je.document_id = p_doc.id)));
    else
      return jsonb_build_object('who', '—', 'text', coalesce((
        select s.description from public.document_statuses s where s.doc_type = p_doc.doc_type and s.code = p_doc.status), ''));
  end case;
end;
$$;

-- Detalle de un documento (buildDetail); el asiento trae "journal" en vez de líneas de productos.
create or replace function private.document_detail(p_doc public.documents)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lines jsonb;
  v_warehouse uuid;
  v_order public.documents;
begin
  case p_doc.doc_type
    when 'PURCHASE_REQUISITION' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', l.notes,
               'qty_ordered', l.qty_ordered) order by l.line_no)
        into v_lines
        from public.purchase_requisition_lines l join public.products p on p.id = l.product_id
       where l.document_id = p_doc.id;
    when 'PURCHASE_ORDER' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', '',
               'unit_price', l.unit_price, 'vat_rate', l.vat_rate, 'line_subtotal', l.line_subtotal, 'line_tax', l.line_tax,
               'line_total', l.line_total, 'qty_received', l.qty_received, 'requisition_label', rd.display_number,
               'requisition_line_id', l.requisition_line_id,
               'requisition_max', case when rl.id is not null then rl.quantity - rl.qty_ordered + l.quantity end) order by l.line_no)
        into v_lines
        from public.purchase_order_lines l
        join public.products p on p.id = l.product_id
        left join public.purchase_requisition_lines rl on rl.id = l.requisition_line_id
        left join public.documents rd on rd.id = rl.document_id
       where l.document_id = p_doc.id;
      select x.warehouse_id into v_warehouse from public.purchase_orders x where x.document_id = p_doc.id;
    when 'GOODS_RECEIPT' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', l.notes,
               'po_line_id', l.po_line_id, 'qty_ordered_po', pl.quantity, 'qty_received', pl.qty_received,
               'unit_cost', l.unit_cost) order by l.line_no)
        into v_lines
        from public.goods_receipt_lines l
        join public.products p on p.id = l.product_id
        left join public.purchase_order_lines pl on pl.id = l.po_line_id
       where l.document_id = p_doc.id;
      select x.warehouse_id into v_warehouse from public.goods_receipts x where x.document_id = p_doc.id;
      select d.* into v_order from public.goods_receipts x join public.documents d on d.id = x.purchase_order_id
       where x.document_id = p_doc.id;
    when 'STOCK_ADJUSTMENT' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity_delta, 'notes', l.notes,
               'unit_cost', l.unit_cost) order by l.line_no)
        into v_lines
        from public.stock_adjustment_lines l join public.products p on p.id = l.product_id
       where l.document_id = p_doc.id;
      select x.warehouse_id into v_warehouse from public.stock_adjustments x where x.document_id = p_doc.id;
    else
      v_lines := null;
  end case;

  return jsonb_build_object(
    'doc', private.document_item(p_doc),
    'lines', coalesce(v_lines, '[]'),
    'journal', case when p_doc.doc_type = 'JOURNAL_ENTRY' then private.journal_view(p_doc) end,
    'supplier', (select to_jsonb(s) from public.suppliers s where s.id = p_doc.supplier_id),
    'warehouse', (select to_jsonb(w) from public.warehouses w where w.id = v_warehouse),
    'related_order', case when v_order.id is not null then private.document_item(v_order) end,
    'approvals', coalesce((
      select jsonb_agg(to_jsonb(a) || jsonb_build_object(
               'approver_role_name', r.name,
               'decided_by_name', case when a.decided_by is not null then private.full_name(a.decided_by) else '' end,
               'requested_by_name', private.full_name(a.requested_by)) order by a.requested_at)
        from public.approval_requests a join public.roles r on r.code = a.approver_role
       where a.document_id = p_doc.id
    ), '[]'),
    'flow', (
      with recursive flow (id) as (
        select p_doc.id
        union
        select case when l.from_document_id = f.id then l.to_document_id else l.from_document_id end
          from flow f join public.document_links l on f.id in (l.from_document_id, l.to_document_id)
      )
      select jsonb_agg(jsonb_build_object(
               'id', d.id, 'doc_type', d.doc_type, 'display_number', d.display_number,
               'status_info', private.status_info(d.doc_type, d.status), 'path', private.doc_path(d.id),
               'current', d.id = p_doc.id, 'readable', d.doc_type = any (private.readable_doc_types(p_doc.company_id)),
               'date', d.created_at)
             order by array_position(
                        array['PURCHASE_REQUISITION', 'PURCHASE_ORDER', 'GOODS_RECEIPT', 'STOCK_ADJUSTMENT', 'JOURNAL_ENTRY'],
                        d.doc_type),
                      d.number)
        from flow f join public.documents d on d.id = f.id
    ),
    'history', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.id) from public.audit_events e where e.document_id = p_doc.id
    ), '[]'),
    'actions', private.available_actions(p_doc),
    'next_step', private.next_step(p_doc),
    'signatures', case p_doc.doc_type
      when 'PURCHASE_REQUISITION' then jsonb_build_array(
        private.signature(p_doc.id, 'Solicitó', array['SUBMIT', 'CREATE']),
        private.signature(p_doc.id, 'Atendió (Compras)', array['SYSTEM']))
      when 'PURCHASE_ORDER' then jsonb_build_array(
        private.signature(p_doc.id, 'Emitió', array['SUBMIT', 'CREATE']),
        private.signature(p_doc.id, 'Autorizó', array['APPROVE']))
      when 'JOURNAL_ENTRY' then jsonb_build_array(
        private.signature(p_doc.id, 'Registró', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Revisó', 'name', '', 'sector', '', 'at', ''))
      else jsonb_build_array(
        private.signature(p_doc.id, 'Recibió / registró', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Controló', 'name', '', 'sector', '', 'at', ''))
    end
  );
end;
$$;

-- ------------------------------------------------------------------ Empresas desde la plantilla

-- Igual que antes, y además copia el plan de cuentas de la plantilla.
create or replace function private.clone_company(p_template uuid, p_course uuid, p_slug text, p_owner uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
  v_member uuid;
begin
  insert into public.companies (id, course_id, slug, legal_name, trade_name, tax_id, vat_condition, activity, address_line,
                                city, province, start_date, simulation_date, is_template, status, settings)
  select v_id, p_course, p_slug, c.legal_name, c.trade_name, c.tax_id, c.vat_condition, c.activity, c.address_line,
         c.city, c.province, c.start_date, c.simulation_date, false, 'ACTIVA', c.settings
    from public.companies c where c.id = p_template;

  insert into public.islands (company_id, number, name)
  select v_id, i.number, i.name from public.islands i where i.company_id = p_template;
  insert into public.sectors (company_id, code, name, island_id)
  select v_id, s.code, s.name, ni.id
    from public.sectors s
    left join public.islands oi on oi.id = s.island_id
    left join public.islands ni on ni.company_id = v_id and ni.number = oi.number
   where s.company_id = p_template;
  insert into public.warehouses (company_id, code, name, is_active)
  select v_id, w.code, w.name, w.is_active from public.warehouses w where w.company_id = p_template;
  insert into public.company_modules (company_id, module_code, is_enabled)
  select v_id, m.module_code, m.is_enabled from public.company_modules m where m.company_id = p_template;
  insert into public.approval_rules (company_id, doc_type, level, min_amount, max_amount, approver_role,
                                     require_different_user, description, is_active)
  select v_id, r.doc_type, r.level, r.min_amount, r.max_amount, r.approver_role, r.require_different_user, r.description, r.is_active
    from public.approval_rules r where r.company_id = p_template;

  insert into public.suppliers (company_id, code, legal_name, trade_name, tax_id, vat_condition, address_line, city, province,
                                phone, email, contact_name, payment_terms_days, lead_time_days, category, notes, is_active)
  select v_id, s.code, s.legal_name, s.trade_name, s.tax_id, s.vat_condition, s.address_line, s.city, s.province,
         s.phone, s.email, s.contact_name, s.payment_terms_days, s.lead_time_days, s.category, s.notes, s.is_active
    from public.suppliers s where s.company_id = p_template;
  insert into public.customers (company_id, code, legal_name, trade_name, tax_id, vat_condition, address_line, city, province,
                                phone, email, contact_name, payment_terms_days, credit_limit, notes, is_active)
  select v_id, c.code, c.legal_name, c.trade_name, c.tax_id, c.vat_condition, c.address_line, c.city, c.province,
         c.phone, c.email, c.contact_name, c.payment_terms_days, c.credit_limit, c.notes, c.is_active
    from public.customers c where c.company_id = p_template;
  -- El proveedor y el depósito habituales apuntan a los de la empresa nueva (mismo código).
  insert into public.products (company_id, code, name, description, category, product_type, uom_code, is_stockable,
                               standard_cost, sale_price, vat_rate, min_stock, reorder_qty, default_supplier_id,
                               default_warehouse_id, location, is_active)
  select v_id, p.code, p.name, p.description, p.category, p.product_type, p.uom_code, p.is_stockable,
         p.standard_cost, p.sale_price, p.vat_rate, p.min_stock, p.reorder_qty, ns.id, nw.id, p.location, p.is_active
    from public.products p
    left join public.suppliers os on os.id = p.default_supplier_id
    left join public.suppliers ns on ns.company_id = v_id and ns.code = os.code
    left join public.warehouses ow on ow.id = p.default_warehouse_id
    left join public.warehouses nw on nw.company_id = v_id and nw.code = ow.code
   where p.company_id = p_template;
  insert into public.accounts (company_id, code, name, account_type, normal_side, level, is_imputable, description, is_active)
  select v_id, a.code, a.name, a.account_type, a.normal_side, a.level, a.is_imputable, a.description, a.is_active
    from public.accounts a where a.company_id = p_template;

  if p_owner is not null then
    insert into public.company_members (company_id, user_id, job_title)
    values (v_id, p_owner, 'Docente a cargo') returning id into v_member;
    insert into public.member_roles (company_id, member_id, role_code) values (v_id, v_member, 'DOCENTE');
  end if;
  return v_id;
end;
$$;

-- Igual que antes, y al final abre la contabilidad con su asiento de apertura.
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
  return jsonb_build_object('id', v_id, 'slug', v_slug);
end;
$$;
