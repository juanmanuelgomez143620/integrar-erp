-- 58. Fase 7a (docs/FASE_7_IMPUESTOS_LOGISTICA_Y_CONTROL.md §2): los libros IVA ventas y
-- compras de cada mes (las facturas por el mes de su asiento; las anuladas restan en el de
-- su contraasiento) y la declaración mensual de IVA (DJ): débito menos crédito fiscal menos
-- el saldo a favor de la anterior; asiento al presentarla y pago por Tesorería (SoD-10: no
-- la paga quien la liquidó). Traducción de la sección "Impuestos" de src/lib/mock/engine.ts
-- y de sus lecturas en queries.ts.
--
-- El tipo de documento, sus estados, transiciones, tareas y claves de imputación están en
-- la migración de catálogos siguiente; las reglas de los asientos, en la de la plantilla.

-- ------------------------------------------------------------------ Tabla

-- La declaración: el impuesto, el mes, lo calculado y el pago.
create table public.tax_returns (
  document_id uuid primary key,
  doc_type text not null default 'TAX_RETURN' check (doc_type = 'TAX_RETURN'),
  company_id uuid not null,
  tax text not null check (tax in ('IVA', 'IIBB')),
  period text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  due_date date not null,
  tax_amount numeric(14, 2) not null,                               -- en el IVA, el débito fiscal
  credits numeric(14, 2) not null,                                  -- en el IVA, el crédito fiscal
  previous_balance numeric(14, 2) not null,                         -- el saldo a favor de la anterior
  balance_in_favor numeric(14, 2) not null,                         -- el que queda para el mes siguiente
  presented_at timestamptz,
  paid_on date,
  paid_account_id uuid,
  unique (company_id, document_id),
  foreign key (company_id, document_id, doc_type) references public.documents (company_id, id, doc_type) on delete cascade,
  foreign key (company_id, paid_account_id) references public.accounts (company_id, id)
);
create index tax_returns_period_idx on public.tax_returns (company_id, tax, period);

alter table public.tax_returns enable row level security;
revoke all on table public.tax_returns from anon, authenticated;
grant select on table public.tax_returns to authenticated;
create trigger tax_returns_same_company before update on public.tax_returns
  for each row execute function private.prevent_company_change();
create policy tax_returns_select on public.tax_returns for select to authenticated
  using (company_id in (select private.companies_with_permission('tax_return.read')));

-- ------------------------------------------------------------------ Auxiliares

-- Un día (dd) del mes siguiente a aaaa-mm: los vencimientos de lo que se liquida por mes (nextMonthDay).
create function private.next_month_day(p_period text, p_day int)
returns date
language sql
immutable
set search_path = ''
as $$ select ((p_period || '-01')::date + interval '1 month' + (p_day - 1) * interval '1 day')::date $$;

-- El mes anterior a aaaa-mm (previousPeriod).
create function private.previous_period(p_period text)
returns text
language sql
immutable
set search_path = ''
as $$ select to_char((p_period || '-01')::date - interval '1 month', 'YYYY-MM') $$;

-- El nombre del impuesto en los textos (TAX_NAMES).
create function private.tax_name(p_tax text)
returns text
language sql
immutable
set search_path = ''
as $$ select case p_tax when 'IVA' then 'IVA' else 'ingresos brutos' end $$;

-- Las facturas del libro IVA de un mes: las de los asientos registrados en el mes que salen
-- de una factura de venta (p_sales) o de proveedor, y las anuladas en el mes, que restan
-- (ivaBookEntries). Una factura de proveedor con letra C va por el total, sin crédito fiscal.
create function private.iva_book_entries(p_company uuid, p_period text, p_sales boolean)
returns table (entry_date date, entry_number int, invoice_id uuid, sign int, voucher text,
               net numeric, vat numeric, exempt numeric, no_credit numeric, total numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with entries as (
    select e.document_date as entry_date, je.entry_number, inv.id as invoice_id, inv.total as invoice_total,
           case when je.reverses_id is null then 1 else -1 end as sign
      from public.journal_entries je
      join public.documents e on e.id = je.document_id
      join public.document_links k on k.to_document_id = coalesce(je.reverses_id, je.document_id)
      join public.documents inv on inv.id = k.from_document_id
                               and inv.doc_type = case when p_sales then 'SALES_INVOICE' else 'SUPPLIER_INVOICE' end
     where e.company_id = p_company and je.entry_number is not null and to_char(e.document_date, 'YYYY-MM') = p_period
  ),
  lines as (
    select l.document_id, l.vat_rate, l.line_subtotal, l.line_tax, l.line_total, true as credit
      from public.sales_invoice_lines l
     where p_sales and l.document_id in (select x.invoice_id from entries x)
    union all
    select l.document_id, l.vat_rate, l.line_subtotal, l.line_tax, l.line_total, s.letter = 'A'
      from public.supplier_invoice_lines l join public.supplier_invoices s on s.document_id = l.document_id
     where not p_sales and l.document_id in (select x.invoice_id from entries x)
  )
  select x.entry_date, x.entry_number, x.invoice_id, x.sign,
         case when p_sales
           then (select f.letter || ' ' || f.point_of_sale || '-' || coalesce(nullif(f.invoice_number, ''), 'sin número')
                   from public.sales_invoices f where f.document_id = x.invoice_id)
           else (select s.letter || ' ' || s.point_of_sale || '-' || s.invoice_number
                   from public.supplier_invoices s where s.document_id = x.invoice_id)
         end,
         round(x.sign * coalesce((select sum(l.line_subtotal) from lines l
                                   where l.document_id = x.invoice_id and l.credit and l.vat_rate > 0), 0), 2),
         round(x.sign * coalesce((select sum(l.line_tax) from lines l
                                   where l.document_id = x.invoice_id and l.credit and l.vat_rate > 0), 0), 2),
         round(x.sign * coalesce((select sum(l.line_subtotal) from lines l
                                   where l.document_id = x.invoice_id and l.credit and l.vat_rate = 0), 0), 2),
         round(x.sign * coalesce((select sum(l.line_total) from lines l
                                   where l.document_id = x.invoice_id and not l.credit), 0), 2),
         round(x.sign * x.invoice_total, 2)
    from entries x
$$;

-- El débito (p_sales) o el crédito fiscal de un mes: el IVA de su libro.
create function private.iva_book_vat(p_company uuid, p_period text, p_sales boolean)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$ select coalesce(round(sum(e.vat), 2), 0) from private.iva_book_entries(p_company, p_period, p_sales) e $$;

-- Quienes liquidaron el impuesto (SoD-10): quien preparó la declaración y quien la presentó (taxReturnPreparers).
create function private.tax_return_preparers(p_doc public.documents)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select array_remove(array[p_doc.created_by, (
    select e.actor_user_id from public.audit_events e
     where e.document_id = p_doc.id and e.action = 'CONFIRM'
     order by e.id
     limit 1)], null)
$$;

-- La declaración posterior de su impuesto, si la hay: sólo se anula la última (laterTaxReturn).
create function private.later_tax_return(p_doc public.documents)
returns public.documents
language sql
stable
security definer
set search_path = ''
as $$
  select d.*
    from public.documents d join public.tax_returns t on t.document_id = d.id
    join public.tax_returns mine on mine.document_id = p_doc.id
   where d.company_id = p_doc.company_id and d.status <> 'ANULADA' and t.tax = mine.tax and t.period > mine.period
   order by t.period
   limit 1
$$;

-- ------------------------------------------------------------------ Comandos

-- Impuestos prepara la declaración de un mes terminado con los libros IVA; después de la
-- primera, los meses van en orden y cada uno con la anterior presentada (cmdCreateTaxReturn).
-- p_input: {tax, period, notes}
create function public.tax_return_create(p_company_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'tax_return.create');
  v_company public.companies;
  v_tax text := coalesce(p_input ->> 'tax', '');
  v_period text := coalesce(p_input ->> 'period', '');
  v_notes text := trim(coalesce(p_input ->> 'notes', ''));
  v_month text;
  v_name text;
  v_same public.documents;
  v_last public.documents;
  v_last_period text;
  v_last_balance numeric;
  v_debit numeric;
  v_credit numeric;
  v_previous numeric;
  v_result numeric;
  v_doc public.documents;
begin
  select * into v_company from public.companies c where c.id = p_company_id;
  if v_tax <> 'IVA' then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el impuesto: por ahora, el IVA.');
  end if;
  if v_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    perform private.raise_business_error('DATO_INVALIDO', 'El período es un mes: aaaa-mm.');
  end if;
  v_month := private.period_label(v_period);
  if v_period >= to_char(private.business_date(p_company_id), 'YYYY-MM') then
    perform private.raise_business_error('DATO_INVALIDO',
      format('%s todavía no terminó: la declaración se prepara después de que termine el mes.', v_month));
  end if;
  if v_period < to_char(v_company.start_date, 'YYYY-MM') then
    perform private.raise_business_error('DATO_INVALIDO',
      format('La empresa empezó sus actividades el %s: no hay declaraciones antes.', to_char(v_company.start_date, 'DD/MM/YYYY')));
  end if;
  v_name := private.tax_name(v_tax);
  select d.* into v_same
    from public.documents d join public.tax_returns t on t.document_id = d.id
   where d.company_id = p_company_id and d.status <> 'ANULADA' and t.tax = v_tax and t.period = v_period;
  if v_same.id is not null then
    perform private.raise_business_error('DATO_INVALIDO',
      format('Ya hay una declaración de %s de %s: %s.', v_name, v_month, v_same.display_number));
  end if;
  select d.* into v_last
    from public.documents d join public.tax_returns t on t.document_id = d.id
   where d.company_id = p_company_id and d.status <> 'ANULADA' and t.tax = v_tax
   order by t.period desc
   limit 1;
  select t.period, t.balance_in_favor into v_last_period, v_last_balance
    from public.tax_returns t where t.document_id = v_last.id;
  if v_last.id is not null and v_period < v_last_period then
    perform private.raise_business_error('DATO_INVALIDO',
      format('La última declaración de %s es la de %s (%s): no se vuelve a un mes anterior.', v_name,
             private.period_label(v_last_period), v_last.display_number));
  end if;
  if v_last.id is not null and private.previous_period(v_period) <> v_last_period then
    perform private.raise_business_error('DATO_INVALIDO',
      format('Falta la declaración de %s de %s: los meses van en orden.', v_name,
             private.period_label(private.previous_period(v_period))));
  end if;
  if v_last.status = 'BORRADOR' then
    perform private.raise_business_error('DATO_INVALIDO',
      format('Primero hay que presentar %s (%s de %s).', v_last.display_number, v_name, private.period_label(v_last_period)));
  end if;
  if length(v_notes) > 500 then
    perform private.raise_business_error('DATO_INVALIDO', 'Las observaciones tienen hasta 500 caracteres.');
  end if;
  v_debit := private.iva_book_vat(p_company_id, v_period, true);
  v_credit := private.iva_book_vat(p_company_id, v_period, false);
  v_previous := coalesce(v_last_balance, 0);
  v_result := round(v_debit - v_credit - v_previous, 2);
  v_doc := private.new_document(p_company_id, 'TAX_RETURN', v_actor, null, v_notes);
  insert into public.tax_returns (document_id, company_id, tax, period, due_date, tax_amount, credits, previous_balance,
                                  balance_in_favor)
  values (v_doc.id, p_company_id, v_tax, v_period,
          private.next_month_day(v_period, case when v_tax = 'IVA' then 20 else 15 end),
          v_debit, v_credit, v_previous, greatest(-v_result, 0));
  update public.documents set subtotal = v_debit, total = greatest(v_result, 0) where id = v_doc.id;
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'tax_return', v_doc.id, v_doc.display_number,
    format('Creó %s: %s de %s, %s', v_doc.display_number, v_name, v_month,
           case when v_result > 0 then format('%s a pagar', private.format_money(v_result))
                else format('saldo a favor de %s', private.format_money(-v_result)) end),
    v_doc.id, null, 'BORRADOR');
  perform private.open_tasks_for_status(v_doc.id, v_actor);
  return private.created_result(v_doc.id);
end;
$$;

-- Presentar: queda fijo lo declarado y se registra el asiento del impuesto; del crédito
-- fiscal se usa hasta el débito y lo que sobra queda en la cuenta (cmdPresentTaxReturn).
create function public.tax_return_present(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_actor private.actor;
  v_t public.tax_returns;
  v_month text;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'TAX_RETURN');
  perform private.require_transition(v_doc, 'CONFIRM');
  perform private.require_permission(v_doc.company_id, 'tax_return.create');
  select * into v_t from public.tax_returns t where t.document_id = v_doc.id;
  v_month := private.period_label(v_t.period);
  v_actor := private.transition_document(v_doc.id, 'CONFIRM',
    p_to => case when v_doc.total > 0 then 'PRESENTADA' else 'SIN_SALDO' end,
    p_summary => format('Presentó %s: %s de %s, %s', v_doc.display_number, private.tax_name(v_t.tax), v_month,
                        case when v_doc.total > 0 then format('%s a pagar', private.format_money(v_doc.total))
                             else 'sin saldo a pagar' end));
  update public.tax_returns set presented_at = now() where document_id = v_doc.id;
  if v_t.tax_amount > 0 then
    perform private.post_event(v_actor, v_doc, 'IVA',
      format('IVA de %s (%s): débito fiscal %s, crédito fiscal %s%s.', v_month, v_doc.display_number,
             private.format_money(v_t.tax_amount), private.format_money(v_t.credits),
             case when v_t.previous_balance <> 0
               then format(' y saldo a favor anterior %s', private.format_money(v_t.previous_balance)) else '' end),
      jsonb_build_array(
        jsonb_build_object('key', 'IVA_DEBITO', 'debit', v_t.tax_amount, 'credit', 0),
        jsonb_build_object('key', 'IVA_CREDITO', 'debit', 0,
                           'credit', least(v_t.tax_amount, round(v_t.credits + v_t.previous_balance, 2))),
        jsonb_build_object('key', 'IVA_A_PAGAR', 'debit', 0, 'credit', v_doc.total)));
  end if;
end;
$$;

-- Tesorería paga el saldo al fisco (simulado) desde una caja o un banco con saldo; SoD-10:
-- no la paga quien la liquidó (cmdPayTaxReturn).
create function public.tax_return_pay(p_document_id uuid, p_account_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_actor private.actor;
  v_t public.tax_returns;
  v_account public.accounts;
  v_balance numeric;
  v_month text;
  v_name text;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'TAX_RETURN');
  perform private.require_transition(v_doc, 'PAY');
  v_actor := private.require_permission(v_doc.company_id, 'tax_return.pay');
  if coalesce((select (c.settings ->> 'sod_enabled')::boolean from public.companies c where c.id = v_doc.company_id), true)
     and not private.is_supervisor(v_doc.company_id)
     and (select auth.uid()) = any (private.tax_return_preparers(v_doc)) then
    perform private.raise_business_error('SEPARACION_FUNCIONES',
      format('No podés pagar %s: la liquidaste vos.', v_doc.display_number),
      'Separación de funciones: quien liquida un impuesto no lo paga. Tiene que pagarlo otro integrante de Tesorería.');
  end if;
  v_account := private.treasury_account(v_doc.company_id, p_account_id::text);
  v_balance := private.account_balance(v_account.id);
  select * into v_t from public.tax_returns t where t.document_id = v_doc.id;
  v_month := private.period_label(v_t.period);
  v_name := private.tax_name(v_t.tax);
  if v_doc.total > v_balance + 0.000000001 then
    perform private.raise_business_error('SALDO_INSUFICIENTE',
      format('No alcanza el saldo de %s %s: hay %s y el %s de %s es %s.', v_account.code, v_account.name,
             private.format_money(v_balance), v_name, v_month, private.format_money(v_doc.total)),
      'Antes de pagar hay que controlar que haya fondos: el flujo de fondos proyectado lo anticipa.');
  end if;
  perform private.transition_document(v_doc.id, 'PAY', p_actor => v_actor,
    p_summary => format('Pagó %s: %s de %s, %s desde %s %s', v_doc.display_number, v_name, v_month,
                        private.format_money(v_doc.total), v_account.code, v_account.name));
  update public.tax_returns
     set paid_on = private.business_date(v_doc.company_id), paid_account_id = v_account.id
   where document_id = v_doc.id;
  select * into v_doc from public.documents d where d.id = v_doc.id;
  perform private.post_event(v_actor, v_doc, 'PAGO_IVA',
    format('Pago del IVA de %s (%s).', v_month, v_doc.display_number),
    jsonb_build_array(
      jsonb_build_object('key', 'IVA_A_PAGAR', 'debit', v_doc.total, 'credit', 0),
      jsonb_build_object('account_id', v_account.id, 'debit', 0, 'credit', v_doc.total)));
end;
$$;

-- Anular: el borrador sin más; la presentada sin pagar, si es la última, con el
-- contraasiento del impuesto (cmdCancelTaxReturn).
create function public.tax_return_cancel(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_actor private.actor;
  v_comment text := trim(coalesce(p_reason, ''));
  v_later public.documents;
  v_entry public.documents;
  v_reversal public.documents;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'TAX_RETURN');
  if v_doc.status not in ('PRESENTADA', 'SIN_SALDO') then
    perform private.transition_document(v_doc.id, 'CANCEL', p_reason);
    return;
  end if;
  v_actor := private.require_permission(v_doc.company_id, 'tax_return.cancel');
  if length(v_comment) < 3 then
    perform private.raise_business_error('MOTIVO_REQUERIDO', 'Indicá el motivo: queda registrado en el historial del documento.');
  end if;
  v_later := private.later_tax_return(v_doc);
  if v_later.id is not null then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('Sólo se anula la última declaración de %s: %s es posterior.',
             private.tax_name((select t.tax from public.tax_returns t where t.document_id = v_doc.id)),
             v_later.display_number));
  end if;
  v_entry := private.automatic_entry_of(v_doc.id);
  if v_entry.id is not null then
    v_reversal := private.reverse_journal_entry(v_entry, v_actor, format('%s anulada: %s', v_doc.display_number, v_comment), true);
  end if;
  perform private.transition_document(v_doc.id, 'CANCEL', v_comment, p_actor => v_actor,
    p_summary => format('Anuló %s%s — %s', v_doc.display_number,
                        case when v_reversal.id is not null
                          then format(': el contraasiento %s revirtió el del impuesto', v_reversal.display_number) else '' end,
                        v_comment));
end;
$$;

grant execute on function public.tax_return_create(uuid, jsonb) to authenticated;
grant execute on function public.tax_return_present(uuid) to authenticated;
grant execute on function public.tax_return_pay(uuid, uuid) to authenticated;
grant execute on function public.tax_return_cancel(uuid, text) to authenticated;

-- ------------------------------------------------------------------ Lecturas

-- La declaración: lo declarado, el saldo y el pago (taxReturnView).
create function private.tax_return_view(p_doc public.documents)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'tax', t.tax, 'period', t.period, 'due_date', t.due_date, 'tax_amount', t.tax_amount, 'credits', t.credits,
    'previous_balance', t.previous_balance, 'amount_due', p_doc.total, 'balance_in_favor', t.balance_in_favor,
    'presented_at', t.presented_at, 'paid_on', t.paid_on,
    'paid_account', (select jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name)
                       from public.accounts a where a.id = t.paid_account_id))
    from public.tax_returns t
   where t.document_id = p_doc.id
$$;

-- El libro IVA ventas (o compras) de un mes, con sus totales y el resumen por alícuota (ivaBook).
create function public.iva_book(p_company_id uuid, p_period text, p_sales boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sales boolean := coalesce(p_sales, true);
begin
  perform private.require_read(p_company_id, 'tax_return.read');
  if coalesce(p_period, '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    perform private.raise_business_error('DATO_INVALIDO', 'El período es un mes: aaaa-mm.');
  end if;
  return (
    with e as (select * from private.iva_book_entries(p_company_id, p_period, v_sales)),
    rates as (
      -- Neto e IVA de cada factura por alícuota (con su signo), sólo lo gravado con crédito fiscal.
      select x.invoice_id, x.sign, x.entry_date, x.entry_number, l.vat_rate as rate,
             round(x.sign * sum(l.line_subtotal), 2) as net, round(x.sign * sum(l.line_tax), 2) as vat
        from e x
        join (
          select l.document_id, l.vat_rate, l.line_subtotal, l.line_tax
            from public.sales_invoice_lines l where v_sales
          union all
          select l.document_id, l.vat_rate, l.line_subtotal, l.line_tax
            from public.supplier_invoice_lines l join public.supplier_invoices s on s.document_id = l.document_id
           where not v_sales and s.letter = 'A'
        ) as l on l.document_id = x.invoice_id
       where l.vat_rate > 0
       group by x.invoice_id, x.sign, x.entry_date, x.entry_number, l.vat_rate
    )
    select jsonb_build_object(
      'period', p_period,
      'sales', v_sales,
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'entry_date', x.entry_date, 'sign', x.sign,
                 'invoice', jsonb_build_object('id', d.id, 'display_number', d.display_number,
                                               'path', private.doc_path(d.id), 'document_date', d.document_date),
                 'voucher', x.voucher,
                 'counterparty', case when v_sales
                   then (select jsonb_build_object('name', c.legal_name, 'tax_id', c.tax_id, 'vat_condition', c.vat_condition)
                           from public.customers c where c.id = d.customer_id)
                   else (select jsonb_build_object('name', s.legal_name, 'tax_id', s.tax_id, 'vat_condition', s.vat_condition)
                           from public.suppliers s where s.id = d.supplier_id) end,
                 'net', x.net, 'vat', x.vat, 'exempt', x.exempt, 'no_credit', x.no_credit, 'total', x.total)
               order by x.entry_date, x.entry_number)
          from e x join public.documents d on d.id = x.invoice_id), '[]'),
      'by_rate', coalesce((
        select jsonb_agg(jsonb_build_object('rate', r.rate, 'net', r.net, 'vat', r.vat) order by r.rate desc)
          from (select r.rate, round(sum(r.net), 2) as net, round(sum(r.vat), 2) as vat from rates r group by r.rate) as r
      ), '[]'),
      'net', (select coalesce(round(sum(x.net), 2), 0) from e x),
      'vat', (select coalesce(round(sum(x.vat), 2), 0) from e x),
      'exempt', (select coalesce(round(sum(x.exempt), 2), 0) from e x),
      'no_credit', (select coalesce(round(sum(x.no_credit), 2), 0) from e x),
      'total', (select coalesce(round(sum(x.total), 2), 0) from e x))
  );
end;
$$;

grant execute on function public.iva_book(uuid, text, boolean) to authenticated;

-- ------------------------------------------------------------------ Flujo de fondos: los impuestos

-- Igual que antes, y los pagos de una declaración son impuestos (cashConcept).
create or replace function private.cash_concept(p_entry uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  with base as (
    select coalesce(je.reverses_id, je.document_id) as id from public.journal_entries je where je.document_id = p_entry
  ),
  source as (
    select s.doc_type
      from base b
      join public.document_links k on k.to_document_id = b.id
      join public.documents s on s.id = k.from_document_id and s.doc_type <> 'JOURNAL_ENTRY'
     limit 1
  )
  select case
    when (select x.doc_type from source x) = 'CUSTOMER_RECEIPT' then 'COBROS'
    when (select x.doc_type from source x) = 'PAYMENT_ORDER' then 'PAGOS'
    when (select x.doc_type from source x) = 'PAYROLL' then 'SUELDOS'
    when (select x.doc_type from source x) = 'TAX_RETURN' then 'IMPUESTOS'
    when (select x.doc_type from source x) = 'FUNDS_TRANSFER' then 'TRANSFERENCIAS'
    when (select je.origin from public.journal_entries je join base b on je.document_id = b.id) = 'APERTURA' then 'APERTURA'
    else 'OTROS'
  end
$$;

-- Igual que antes, con el concepto "Impuestos" (cashFlow).
create or replace function public.cash_flow(p_company_id uuid, p_from text, p_to text)
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
  perform private.require_read(p_company_id, 'treasury.read');
  select r.date_from, r.date_to into v_from, v_to from private.book_range(p_from, p_to) as r;
  return (
    with treasury as (
      select a.id, a.code, a.name from public.accounts a
       where a.company_id = p_company_id and a.is_imputable and starts_with(a.code, private.treasury_rubro() || '.')
    ),
    moves as (
      select l.account_id, l.debit, l.credit, d.document_date, private.cash_concept(d.id) as concept
        from public.journal_entry_lines l
        join public.journal_entries je on je.document_id = l.document_id and je.entry_number is not null
        join public.documents d on d.id = l.document_id
       where l.account_id in (select t.id from treasury t)
    ),
    accounts as (
      select t.id, t.code, t.name,
             coalesce(sum(m.debit - m.credit) filter (where m.document_date < v_from), 0) as opening,
             coalesce(sum(m.debit) filter (where m.document_date between v_from and v_to), 0) as inflow,
             coalesce(sum(m.credit) filter (where m.document_date between v_from and v_to), 0) as outflow
        from treasury t left join moves m on m.account_id = t.id
       group by t.id, t.code, t.name
    ),
    concepts (key, label, sort) as (
      values ('APERTURA', 'Saldos de apertura', 1), ('COBROS', 'Cobros a clientes', 2), ('PAGOS', 'Pagos a proveedores', 3),
             ('SUELDOS', 'Sueldos y cargas sociales', 4), ('IMPUESTOS', 'Impuestos', 5),
             ('TRANSFERENCIAS', 'Movimientos entre cajas y bancos', 6), ('OTROS', 'Otros asientos de Contabilidad', 7)
    )
    select jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'opening', (select coalesce(sum(a.opening), 0) from accounts a),
      'inflow', (select coalesce(sum(a.inflow), 0) from accounts a),
      'outflow', (select coalesce(sum(a.outflow), 0) from accounts a),
      'closing', (select coalesce(sum(a.opening + a.inflow - a.outflow), 0) from accounts a),
      'concepts', (
        select jsonb_agg(jsonb_build_object(
                 'key', c.key, 'label', c.label,
                 'inflow', coalesce((select sum(m.debit) from moves m
                                      where m.concept = c.key and m.document_date between v_from and v_to), 0),
                 'outflow', coalesce((select sum(m.credit) from moves m
                                       where m.concept = c.key and m.document_date between v_from and v_to), 0))
               order by c.sort)
          from concepts c),
      'accounts', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'account', jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name),
                 'opening', a.opening, 'inflow', a.inflow, 'outflow', a.outflow,
                 'closing', a.opening + a.inflow - a.outflow)
               order by a.code collate "C")
          from accounts a), '[]'::jsonb)
    )
  );
end;
$$;

-- Igual que antes, y además los saldos de las declaraciones de impuestos presentadas sin
-- pagar, en su vencimiento: el saldo tras cada tramo también los resta (cashProjection).
create or replace function public.cash_projection(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date;
  v_balance numeric;
begin
  perform private.require_read(p_company_id, 'treasury.read');
  v_today := private.business_date(p_company_id);
  select coalesce(sum(l.debit - l.credit), 0) into v_balance
    from public.journal_entry_lines l
    join public.journal_entries je on je.document_id = l.document_id and je.entry_number is not null
    join public.accounts a on a.id = l.account_id
   where a.company_id = p_company_id and a.is_imputable and starts_with(a.code, private.treasury_rubro() || '.');
  return (
    with pending as (
      select si.due_date - v_today as days, d.total - private.invoice_paid(d.id) as pending
        from public.documents d join public.supplier_invoices si on si.document_id = d.id
       where d.company_id = p_company_id and d.doc_type = 'SUPPLIER_INVOICE'
         and d.status in ('REGISTRADA', 'PAGADA_PARCIAL', 'PAGADA')
    ),
    receivable as (
      select x.due_date - v_today as days, private.sales_invoice_pending(d.id) as pending
        from public.documents d join public.sales_invoices x on x.document_id = d.id
       where d.company_id = p_company_id and d.doc_type = 'SALES_INVOICE'
         and d.status = any (private.invoiced_sales_statuses())
    ),
    payroll as (
      select x.days, x.amount
        from (
          select p.payment_date - v_today as days, d.total as amount
            from public.documents d join public.payrolls p on p.document_id = d.id
           where d.company_id = p_company_id and d.status = 'CONFIRMADA'
          union all
          select private.payroll_charges_due(p.period) - v_today, private.payroll_charges(d.id)
            from public.documents d join public.payrolls p on p.document_id = d.id
           where d.company_id = p_company_id and d.status in ('CONFIRMADA', 'SUELDOS_PAGADOS')
        ) as x
       where x.amount > 0
    ),
    taxes as (
      select t.due_date - v_today as days, d.total as amount
        from public.documents d join public.tax_returns t on t.document_id = d.id
       where d.company_id = p_company_id and d.status = 'PRESENTADA'
    ),
    buckets (key, label, sort, lo, hi) as (
      values ('VENCIDAS', 'Vencidas', 1, null::int, -1), ('SEMANA', 'Próximos 7 días', 2, 0, 7),
             ('QUINCENA', 'De 8 a 15 días', 3, 8, 15), ('MES', 'De 16 a 30 días', 4, 16, 30),
             ('DESPUES', 'A más de 30 días', 5, 31, null::int)
    ),
    totals as (
      select b.key, b.label, b.sort,
             coalesce(sum(p.pending) filter (where p.pending > 0), 0) as payments,
             count(p.pending) filter (where p.pending > 0) as invoices,
             coalesce((select sum(r.pending) from receivable r
                        where r.pending > 0 and (b.lo is null or r.days >= b.lo) and (b.hi is null or r.days <= b.hi)), 0) as collections,
             (select count(*) from receivable r
               where r.pending > 0 and (b.lo is null or r.days >= b.lo) and (b.hi is null or r.days <= b.hi)) as receivables,
             coalesce((select sum(s.amount) from payroll s
                        where (b.lo is null or s.days >= b.lo) and (b.hi is null or s.days <= b.hi)), 0) as payroll,
             (select count(*) from payroll s
               where (b.lo is null or s.days >= b.lo) and (b.hi is null or s.days <= b.hi)) as payroll_items,
             coalesce((select sum(s.amount) from taxes s
                        where (b.lo is null or s.days >= b.lo) and (b.hi is null or s.days <= b.hi)), 0) as taxes,
             (select count(*) from taxes s
               where (b.lo is null or s.days >= b.lo) and (b.hi is null or s.days <= b.hi)) as tax_items
        from buckets b
        left join pending p on (b.lo is null or p.days >= b.lo) and (b.hi is null or p.days <= b.hi)
       group by b.key, b.label, b.sort, b.lo, b.hi
    ),
    running as (
      select t.*, v_balance + sum(t.collections - t.payments - t.payroll - t.taxes) over (order by t.sort) as balance from totals t
    )
    select jsonb_build_object(
      'today', v_today,
      'balance', v_balance,
      'buckets', (
        select jsonb_agg(jsonb_build_object('key', r.key, 'label', r.label, 'collections', r.collections,
                                            'receivables', r.receivables, 'payments', r.payments,
                                            'invoices', r.invoices, 'payroll', r.payroll,
                                            'payroll_items', r.payroll_items, 'taxes', r.taxes,
                                            'tax_items', r.tax_items, 'balance', r.balance) order by r.sort)
          from running r),
      'shortfall', (select r.key from running r where r.balance < 0 order by r.sort limit 1)
    )
  );
end;
$$;

-- ------------------------------------------------------------------ Lecturas comunes, con la declaración de impuestos

-- Igual que antes, con la cabecera de la declaración de impuestos (document_json).
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
    || coalesce((
      select jsonb_build_object('si', jsonb_build_object(
               'purchase_order_id', x.purchase_order_id, 'letter', x.letter, 'point_of_sale', x.point_of_sale,
               'invoice_number', x.invoice_number, 'due_date', x.due_date, 'registered_at', x.registered_at))
        from public.supplier_invoices x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('op', jsonb_build_object(
               'treasury_account_id', x.treasury_account_id, 'payment_reference', x.payment_reference, 'paid_on', x.paid_on,
               'payment_method', x.payment_method))
        from public.payment_orders x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('rq', jsonb_build_object(
               'response_due', x.response_due, 'warehouse_id', x.warehouse_id, 'award_reason', x.award_reason))
        from public.rfqs x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('sq', jsonb_build_object(
               'rfq_id', x.rfq_id, 'supplier_reference', x.supplier_reference, 'valid_until', x.valid_until,
               'delivery_days', x.delivery_days, 'payment_terms_days', x.payment_terms_days))
        from public.supplier_quotes x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('ft', jsonb_build_object(
               'from_account_id', x.from_account_id, 'to_account_id', x.to_account_id, 'reference', x.reference,
               'transferred_on', x.transferred_on))
        from public.funds_transfers x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('br', jsonb_build_object(
               'account_id', x.account_id, 'statement_date', x.statement_date, 'statement_balance', x.statement_balance,
               'book_balance', x.book_balance, 'pending_debits', x.pending_debits, 'pending_credits', x.pending_credits))
        from public.bank_reconciliations x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('so', jsonb_build_object(
               'warehouse_id', x.warehouse_id, 'delivery_date', x.delivery_date, 'payment_terms_days', x.payment_terms_days,
               'customer_reference', x.customer_reference, 'credit_reason', x.credit_reason, 'confirmed_at', x.confirmed_at))
        from public.sales_orders x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('dn', jsonb_build_object(
               'sales_order_id', x.sales_order_id, 'warehouse_id', x.warehouse_id, 'carrier_name', x.carrier_name,
               'dispatched_at', x.dispatched_at))
        from public.delivery_notes x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('fv', jsonb_build_object(
               'sales_order_id', x.sales_order_id, 'letter', x.letter, 'point_of_sale', x.point_of_sale,
               'invoice_number', x.invoice_number, 'due_date', x.due_date, 'registered_at', x.registered_at))
        from public.sales_invoices x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('rc', jsonb_build_object(
               'treasury_account_id', x.treasury_account_id, 'payment_method', x.payment_method, 'reference', x.reference,
               'received_on', x.received_on))
        from public.customer_receipts x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('qt', jsonb_build_object(
               'valid_until', x.valid_until, 'warehouse_id', x.warehouse_id, 'payment_terms_days', x.payment_terms_days,
               'customer_reference', x.customer_reference))
        from public.sales_quotes x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('pd', jsonb_build_object(
               'product_id', x.product_id, 'quantity', x.quantity, 'materials_warehouse_id', x.materials_warehouse_id,
               'output_warehouse_id', x.output_warehouse_id, 'due_date', x.due_date, 'quantity_produced', x.quantity_produced,
               'unit_cost', x.unit_cost, 'released_at', x.released_at, 'issued_at', x.issued_at, 'finished_at', x.finished_at))
        from public.production_orders x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('py', jsonb_build_object(
               'period', x.period, 'payment_date', x.payment_date, 'rates', x.rates, 'confirmed_at', x.confirmed_at,
               'salaries_paid_on', x.salaries_paid_on, 'salaries_account_id', x.salaries_account_id,
               'charges_paid_on', x.charges_paid_on, 'charges_account_id', x.charges_account_id))
        from public.payrolls x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('tr', jsonb_build_object(
               'tax', x.tax, 'period', x.period, 'due_date', x.due_date, 'tax_amount', x.tax_amount, 'credits', x.credits,
               'previous_balance', x.previous_balance, 'balance_in_favor', x.balance_in_favor,
               'presented_at', x.presented_at, 'paid_on', x.paid_on, 'paid_account_id', x.paid_account_id))
        from public.tax_returns x where x.document_id = p_doc.id), '{}')
$$;

-- Igual que antes, con la declaración de impuestos: se resume por el impuesto y el mes.
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
    select l.line_no, l.product_id from public.supplier_invoice_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.rfq_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.supplier_quote_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.sales_order_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.delivery_note_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.sales_invoice_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.sales_quote_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.production_order_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, null::uuid from public.journal_entry_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, null::uuid from public.payment_order_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, null::uuid from public.customer_receipt_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, null::uuid from public.bank_reconciliation_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, null::uuid from public.payroll_lines l where l.document_id = p_doc.id
  ),
  codes as (
    select array_agg(p.code order by l.line_no) as list, count(*) as n
      from lines l join public.products p on p.id = l.product_id
  ),
  invoices as (
    select array_agg(d.display_number order by l.line_no) as list, count(*) as n
      from (
        select x.line_no, x.invoice_id from public.payment_order_lines x where x.document_id = p_doc.id
        union all
        select x.line_no, x.invoice_id from public.customer_receipt_lines x where x.document_id = p_doc.id
      ) as l
      join public.documents d on d.id = l.invoice_id
  )
  select private.document_json(p_doc) || jsonb_build_object(
    'status_info', private.status_info(p_doc.doc_type, p_doc.status),
    'supplier_name', coalesce((select s.legal_name from public.suppliers s where s.id = p_doc.supplier_id), ''),
    'customer_name', coalesce((select c.legal_name from public.customers c where c.id = p_doc.customer_id), ''),
    'sector_name', coalesce((select s.name from public.sectors s where s.id = p_doc.sector_id), '—'),
    'created_by_name', private.full_name(p_doc.created_by),
    'line_count', (select count(*) from lines),
    'summary', coalesce(
      (select je.description from public.journal_entries je where je.document_id = p_doc.id),
      case when p_doc.doc_type in ('PAYMENT_ORDER', 'CUSTOMER_RECEIPT') then
        (select coalesce(array_to_string(i.list[1:3], ', '), '') || case when i.n > 3 then format(' y %s más', i.n - 3) else '' end
           from invoices i)
      end,
      (select fa.name || ' → ' || ta.name
         from public.funds_transfers t
         join public.accounts fa on fa.id = t.from_account_id
         join public.accounts ta on ta.id = t.to_account_id
        where t.document_id = p_doc.id),
      (select a.name || ' al ' || to_char(r.statement_date, 'DD/MM/YYYY')
         from public.bank_reconciliations r join public.accounts a on a.id = r.account_id
        where r.document_id = p_doc.id),
      (select 'Sueldos de ' || private.period_label(x.period) from public.payrolls x where x.document_id = p_doc.id),
      (select case when x.tax = 'IVA' then 'IVA' else 'Ingresos brutos' end || ' de ' || private.period_label(x.period)
         from public.tax_returns x where x.document_id = p_doc.id),
      (select p.code || ' ' || p.name
         from public.production_orders o join public.products p on p.id = o.product_id
        where o.document_id = p_doc.id),
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

-- Igual que antes, con la declaración de impuestos: Impuestos la presenta y Tesorería la paga (nextStep).
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
  v_loaded int;
  v_invited int;
  v_awarded public.documents;
  v_rfq_number text;
begin
  case p_doc.doc_type || ':' || p_doc.status
    when 'PURCHASE_REQUISITION:BORRADOR' then
      return jsonb_build_object('who', v_sector,
        'text', 'Completar los ítems, justificar la necesidad y enviar la solicitud a Compras.');
    when 'PURCHASE_REQUISITION:SOLICITADO' then
      return jsonb_build_object('who', 'Compras',
        'text', 'Debe pedir cotizaciones o incluir la solicitud en una orden de compra a un proveedor, o rechazarla indicando el motivo.');
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
      return jsonb_build_object('who', 'Compras',
        'text', 'Llegó todo lo pedido. Cuando llegue la factura del proveedor, se registra contra esta orden y lo recibido.');
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
    when 'SUPPLIER_INVOICE:BORRADOR' then
      return jsonb_build_object('who', 'Compras',
        'text', 'Controlar el comprobante del proveedor contra la orden de compra y lo recibido, y registrar la factura.');
    when 'SUPPLIER_INVOICE:REGISTRADA', 'SUPPLIER_INVOICE:PAGADA_PARCIAL' then
      return jsonb_build_object('who', 'Contabilidad y Tesorería',
        'text', format('La deuda está en la cuenta corriente del proveedor y vence el %s. Se cancela con una orden de pago.',
                       (select to_char(si.due_date, 'DD/MM/YYYY') from public.supplier_invoices si where si.document_id = p_doc.id)));
    when 'PAYMENT_ORDER:BORRADOR' then
      return jsonb_build_object('who', 'Contabilidad o Tesorería',
        'text', 'Revisar las facturas, los importes y la caja o el banco, y enviar la orden a aprobación.');
    when 'PAYMENT_ORDER:PENDIENTE_APROBACION' then
      return jsonb_build_object('who', 'Gerencia',
        'text', 'Autorizar el pago o rechazarlo con motivo. Quien preparó la orden no puede aprobarla: es un control de separación de funciones.');
    when 'PAYMENT_ORDER:APROBADA' then
      return jsonb_build_object('who', 'Tesorería',
        'text', format('Pagar desde %s y registrar el pago: el asiento se genera solo. Quien registró una de las facturas no puede pagarla.',
                       coalesce((select a.code || ' ' || a.name from public.payment_orders po
                                   join public.accounts a on a.id = po.treasury_account_id
                                  where po.document_id = p_doc.id), 'la caja o el banco')));
    when 'PAYMENT_ORDER:PAGADA' then
      return jsonb_build_object('who', '—',
        'text', format('Se pagó el %s: la deuda bajó en la cuenta corriente del proveedor y el pago está en el libro diario.',
                       (select to_char(po.paid_on, 'DD/MM/YYYY') from public.payment_orders po where po.document_id = p_doc.id)));
    when 'PAYMENT_ORDER:RECHAZADA' then
      return jsonb_build_object('who', 'Contabilidad o Tesorería',
        'text', format('Motivo del rechazo: "%s". Si igual hay que pagar, se prepara otra orden.', p_doc.status_reason));
    when 'RFQ:BORRADOR' then
      return jsonb_build_object('who', 'Compras',
        'text', 'Revisar los ítems, las cantidades y los proveedores invitados, y enviar la solicitud. Si algo está mal, se anula y se prepara otra.');
    when 'RFQ:ENVIADA' then
      select count(*) into v_loaded from private.rfq_quotes(p_doc.id);
      select count(*) into v_invited from public.rfq_suppliers s where s.document_id = p_doc.id;
      return jsonb_build_object('who', 'Compras', 'text', case when v_loaded > 0
        then format('Hay %s de %s cotizaciones cargadas. Compararlas en el cuadro y adjudicar: se genera la orden de compra en borrador. Si no es la más conveniente por precio, hay que justificar la elección.',
                    v_loaded, v_invited)
        else format('Mandar la solicitud impresa a cada proveedor invitado y cargar sus cotizaciones a medida que lleguen (responden hasta el %s).',
                    (select to_char(r.response_due, 'DD/MM/YYYY') from public.rfqs r where r.document_id = p_doc.id))
      end);
    when 'RFQ:ADJUDICADA' then
      select * into v_awarded from private.rfq_quotes(p_doc.id) q where q.status = 'ADJUDICADA' order by q.number limit 1;
      return jsonb_build_object('who', 'Compras',
        'text', format('Se adjudicó a %s (%s) y se generó %s: la compra sigue en esa orden.',
                       coalesce((select s.legal_name from public.suppliers s where s.id = v_awarded.supplier_id), '—'),
                       coalesce(v_awarded.display_number, '—'),
                       coalesce((select d.display_number from public.documents d where d.id = private.order_from_quote(v_awarded.id)),
                                'la orden de compra')));
    when 'SUPPLIER_QUOTE:RECIBIDA' then
      select r.display_number into v_rfq_number
        from public.supplier_quotes q join public.documents r on r.id = q.rfq_id where q.document_id = p_doc.id;
      return jsonb_build_object('who', 'Compras',
        'text', format('Participa del cuadro comparativo de %s. Se adjudica desde la solicitud; si se cargó mal, se anula y se carga de nuevo.',
                       coalesce(v_rfq_number, '—')));
    when 'SUPPLIER_QUOTE:ADJUDICADA' then
      select r.display_number into v_rfq_number
        from public.supplier_quotes q join public.documents r on r.id = q.rfq_id where q.document_id = p_doc.id;
      return jsonb_build_object('who', '—',
        'text', format('Fue la elegida en %s: de ella nació %s.', coalesce(v_rfq_number, '—'),
                       coalesce((select d.display_number from public.documents d where d.id = private.order_from_quote(p_doc.id)),
                                'la orden de compra')));
    when 'BANK_RECONCILIATION:CONFIRMADA' then
      return jsonb_build_object('who', '—',
        'text', (select format('Cierra con el extracto al %s. Lo pendiente (%s en pagos sin debitar y %s en entradas sin acreditar) se controla en la próxima conciliación.',
                               to_char(r.statement_date, 'DD/MM/YYYY'), private.format_money(r.pending_credits),
                               private.format_money(r.pending_debits))
                   from public.bank_reconciliations r where r.document_id = p_doc.id));
    when 'FUNDS_TRANSFER:BORRADOR' then
      return jsonb_build_object('who', 'Tesorería',
        'text', 'Revisar las cuentas y el importe, y confirmar la transferencia: se controla el saldo de la cuenta de origen y se genera el asiento.');
    when 'FUNDS_TRANSFER:CONFIRMADA' then
      return jsonb_build_object('who', '—',
        'text', (select format('Se transfirió el %s de %s a %s: el movimiento está en el libro diario y no cambia el total de los fondos.',
                               coalesce(to_char(t.transferred_on, 'DD/MM/YYYY'), '—'), fa.name, ta.name)
                   from public.funds_transfers t
                   join public.accounts fa on fa.id = t.from_account_id
                   join public.accounts ta on ta.id = t.to_account_id
                  where t.document_id = p_doc.id));
    when 'SALES_ORDER:BORRADOR' then
      return jsonb_build_object('who', 'Ventas',
        'text', 'Revisar el cliente, los ítems, los precios y el depósito, y confirmar el pedido: se controla el stock disponible y el crédito del cliente, y se reserva la mercadería.');
    when 'SALES_ORDER:PENDIENTE_APROBACION' then
      return jsonb_build_object('who', 'Gerencia',
        'text', trim(coalesce((select so.credit_reason from public.sales_orders so where so.document_id = p_doc.id), '')
                     || ' Autorizar el crédito o rechazar el pedido con motivo; mientras tanto, la mercadería queda reservada. Quien cargó el pedido no puede autorizarlo: es un control de separación de funciones.'));
    when 'SALES_ORDER:CONFIRMADO' then
      return jsonb_build_object('who', 'Depósito',
        'text', format('La mercadería está reservada en %s. Prepararla, cargar el remito y despacharlo.',
                       coalesce((select w.name from public.sales_orders so join public.warehouses w on w.id = so.warehouse_id
                                  where so.document_id = p_doc.id), 'el depósito')));
    when 'SALES_ORDER:ENTREGADO_PARCIAL' then
      return jsonb_build_object('who', 'Depósito o Ventas',
        'text', 'Falta entregar el saldo, que sigue reservado. Si no se va a entregar, Ventas puede cerrar el saldo con motivo.');
    when 'SALES_ORDER:ENTREGADO' then
      if private.uninvoiced_delivery(p_doc.id) then
        return jsonb_build_object('who', 'Ventas', 'text', 'Se entregó todo lo pedido: falta facturar lo entregado.');
      end if;
      return jsonb_build_object('who', '—',
        'text', 'Se entregó y se facturó todo lo pedido: la deuda está en la cuenta corriente del cliente.');
    when 'SALES_ORDER:CERRADO' then
      if private.uninvoiced_delivery(p_doc.id) then
        return jsonb_build_object('who', 'Ventas',
          'text', 'Se cerró con saldo sin entregar: falta facturar lo que sí se entregó.');
      end if;
      return jsonb_build_object('who', '—', 'text', coalesce((
        select s.description from public.document_statuses s where s.doc_type = 'SALES_ORDER' and s.code = 'CERRADO'), ''));
    when 'SALES_INVOICE:BORRADOR' then
      return jsonb_build_object('who', 'Ventas',
        'text', 'Revisar las cantidades contra lo entregado y registrar la factura: se le asigna el número y se generan el asiento de venta y la deuda del cliente.');
    when 'SALES_INVOICE:REGISTRADA' then
      return jsonb_build_object('who', 'Tesorería',
        'text', format('La deuda está en la cuenta corriente del cliente y vence el %s. Se cancela cuando el cliente paga, con un recibo de cobro.',
                       (select to_char(x.due_date, 'DD/MM/YYYY') from public.sales_invoices x where x.document_id = p_doc.id)));
    when 'SALES_INVOICE:COBRADA_PARCIAL' then
      return jsonb_build_object('who', 'Tesorería',
        'text', format('El cliente pagó una parte: quedan %s en su cuenta corriente (vence el %s). El saldo se cancela con otro recibo de cobro.',
                       private.format_money(private.sales_invoice_pending(p_doc.id)),
                       (select to_char(x.due_date, 'DD/MM/YYYY') from public.sales_invoices x where x.document_id = p_doc.id)));
    when 'PRODUCTION_ORDER:BORRADOR' then
      return jsonb_build_object('who', 'Producción', 'text', case when private.production_shortages(p_doc) is not null
        then format('Faltan materiales: %s. Pedíselos a Compras (o fabricá menos unidades) y liberá la orden cuando lleguen.',
                    private.production_shortages(p_doc))
        else 'Revisar el producto, la cantidad y los materiales, y liberar la orden: se controla que haya materiales y quedan reservados para Depósito.'
      end);
    when 'PRODUCTION_ORDER:LIBERADA' then
      return jsonb_build_object('who', 'Depósito',
        'text', format('Los materiales están reservados en %s. Prepararlos, entregárselos a Producción y registrar lo que sale de cada uno.',
                       coalesce((select w.name from public.production_orders o join public.warehouses w on w.id = o.materials_warehouse_id
                                  where o.document_id = p_doc.id), 'el depósito')));
    when 'PRODUCTION_ORDER:EN_PROCESO' then
      return jsonb_build_object('who', 'Producción',
        'text', 'Fabricar y, al terminar, registrar las unidades que salieron bien: entran al stock a su costo real.');
    when 'PRODUCTION_ORDER:TERMINADA' then
      return (
        select jsonb_build_object('who', '—',
          'text', format('Ingresaron %s de %s a %s por unidad (ver kardex): el costo pasó de productos en proceso a productos terminados.',
                         private.format_qty(coalesce(o.quantity_produced, 0), p.uom_code), p.code,
                         private.format_money(coalesce(o.unit_cost, 0))))
          from public.production_orders o join public.products p on p.id = o.product_id
         where o.document_id = p_doc.id);
    when 'PAYROLL:BORRADOR' then
      return jsonb_build_object('who', 'RRHH',
        'text', 'Cargar las novedades del mes de cada empleado (días trabajados, ausencias sin aviso y horas extra), revisar los recibos y confirmar la liquidación: se registra el asiento de sueldos.');
    when 'PAYROLL:CONFIRMADA' then
      return jsonb_build_object('who', 'Tesorería',
        'text', format('Pagar los sueldos el %s: %s netos. Los aportes retenidos y las contribuciones quedan en Cargas sociales a pagar hasta que se depositen.',
                       coalesce((select to_char(x.payment_date, 'DD/MM/YYYY') from public.payrolls x
                                  where x.document_id = p_doc.id), '—'),
                       private.format_money(p_doc.total)));
    when 'PAYROLL:SUELDOS_PAGADOS' then
      return (
        select jsonb_build_object('who', 'Tesorería',
          'text', format('Pagar las cargas sociales antes del %s: %s entre los aportes retenidos a los empleados y las contribuciones de la empresa.',
                         to_char(private.payroll_charges_due(x.period), 'DD/MM/YYYY'),
                         private.format_money(private.payroll_charges(p_doc.id))))
          from public.payrolls x where x.document_id = p_doc.id);
    when 'SALES_QUOTE:BORRADOR' then
      return jsonb_build_object('who', 'Ventas', 'text', case when private.sales_quote_expired(p_doc)
        then format('Venció el %s: anularlo y, si hace falta, preparar otro con los precios del día.',
                    (select to_char(q.valid_until, 'DD/MM/YYYY') from public.sales_quotes q where q.document_id = p_doc.id))
        else 'Revisar los ítems, los precios y la validez, e imprimir el presupuesto para enviárselo al cliente.'
      end);
    when 'SALES_QUOTE:ENVIADO' then
      return jsonb_build_object('who', 'Ventas', 'text', case when private.sales_quote_expired(p_doc)
        then format('La oferta venció el %s: darlo por vencido y, si el cliente sigue interesado, preparar otro con los precios del día.',
                    (select to_char(q.valid_until, 'DD/MM/YYYY') from public.sales_quotes q where q.document_id = p_doc.id))
        else format('El cliente tiene hasta el %s para responder. Si acepta, se registra la aceptación y se genera el pedido de venta; si no, el rechazo con su motivo.',
                    (select to_char(q.valid_until, 'DD/MM/YYYY') from public.sales_quotes q where q.document_id = p_doc.id))
      end);
    when 'SALES_QUOTE:ACEPTADO' then
      return jsonb_build_object('who', 'Ventas',
        'text', format('El cliente lo aceptó: se generó %s en borrador. Ventas lo revisa y lo confirma: ahí se controlan el stock y el crédito.',
                       coalesce((private.order_from_sales_quote(p_doc.id)).display_number, 'el pedido de venta')));
    when 'SALES_QUOTE:RECHAZADO' then
      return jsonb_build_object('who', '—', 'text', format('Motivo del cliente: "%s".', p_doc.status_reason));
    when 'CUSTOMER_RECEIPT:BORRADOR' then
      return jsonb_build_object('who', 'Tesorería',
        'text', 'Revisar las facturas, los importes, el medio de cobro y la caja o el banco, y confirmar el cobro: se genera el asiento y baja la deuda del cliente. Quien emitió una de las facturas no puede registrar su cobro.');
    when 'CUSTOMER_RECEIPT:CONFIRMADO' then
      return jsonb_build_object('who', '—',
        'text', (select format('Se cobró el %s: la deuda bajó en la cuenta corriente del cliente y el cobro está en el libro diario.%s',
                               coalesce(to_char(x.received_on, 'DD/MM/YYYY'), '—'),
                               case when x.payment_method = 'CHEQUE'
                                 then ' Para depositar el cheque en el banco, Tesorería prepara una transferencia entre cuentas.' else '' end)
                   from public.customer_receipts x where x.document_id = p_doc.id));
    when 'SALES_ORDER:RECHAZADO' then
      return jsonb_build_object('who', 'Ventas',
        'text', format('Motivo del rechazo: "%s". Si el cliente achica el pedido o paga lo que debe, se carga otro.', p_doc.status_reason));
    when 'DELIVERY_NOTE:BORRADOR' then
      return jsonb_build_object('who', 'Depósito',
        'text', 'Preparar la mercadería, controlarla contra el remito y despacharlo: baja el stock, se libera la reserva y se registra el costo de lo vendido.');
    when 'DELIVERY_NOTE:CONFIRMADO' then
      return jsonb_build_object('who', '—',
        'text', 'La mercadería salió: bajó el stock (ver kardex), el costo de lo vendido está en el libro diario y Ventas fue notificada.');
    when 'TAX_RETURN:BORRADOR' then
      return jsonb_build_object('who', 'Impuestos',
        'text', 'Revisar los libros IVA del mes (el débito y el crédito fiscal) y presentar la declaración: se registra el asiento del impuesto.');
    when 'TAX_RETURN:PRESENTADA' then
      return jsonb_build_object('who', 'Tesorería',
        'text', format('Pagar %s al fisco (simulado) antes del %s.', private.format_money(p_doc.total),
                       coalesce((select to_char(t.due_date, 'DD/MM/YYYY') from public.tax_returns t
                                  where t.document_id = p_doc.id), '—')));
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

-- Igual que antes, con la declaración de impuestos: su vista, su lugar en el flujo y sus firmas.
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
    when 'SUPPLIER_INVOICE' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', '',
               'po_line_id', l.po_line_id, 'qty_ordered_po', pl.quantity, 'qty_received', pl.qty_received,
               'unit_price', l.unit_price, 'order_unit_price', pl.unit_price, 'vat_rate', l.vat_rate,
               'line_subtotal', l.line_subtotal, 'line_tax', l.line_tax, 'line_total', l.line_total) order by l.line_no)
        into v_lines
        from public.supplier_invoice_lines l
        join public.products p on p.id = l.product_id
        left join public.purchase_order_lines pl on pl.id = l.po_line_id
       where l.document_id = p_doc.id;
      select d.* into v_order from public.supplier_invoices x join public.documents d on d.id = x.purchase_order_id
       where x.document_id = p_doc.id;
    when 'RFQ' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', l.notes,
               'requisition_label', rd.display_number, 'requisition_line_id', l.requisition_line_id) order by l.line_no)
        into v_lines
        from public.rfq_lines l
        join public.products p on p.id = l.product_id
        left join public.purchase_requisition_lines rl on rl.id = l.requisition_line_id
        left join public.documents rd on rd.id = rl.document_id
       where l.document_id = p_doc.id;
      select x.warehouse_id into v_warehouse from public.rfqs x where x.document_id = p_doc.id;
    when 'SUPPLIER_QUOTE' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', '',
               'unit_price', l.unit_price, 'vat_rate', l.vat_rate, 'line_subtotal', l.line_subtotal, 'line_tax', l.line_tax,
               'line_total', l.line_total) order by l.line_no)
        into v_lines
        from public.supplier_quote_lines l join public.products p on p.id = l.product_id
       where l.document_id = p_doc.id;
    when 'SALES_ORDER' then
      select x.warehouse_id into v_warehouse from public.sales_orders x where x.document_id = p_doc.id;
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', '',
               'unit_price', l.unit_price, 'list_price', l.list_price, 'vat_rate', l.vat_rate,
               'line_subtotal', l.line_subtotal, 'line_tax', l.line_tax, 'line_total', l.line_total,
               'qty_delivered', l.qty_delivered, 'qty_invoiced', private.sales_invoiced_quantity(l.id),
               'qty_available', case when p.is_stockable then
                 round(private.on_hand_quantity(p.id, v_warehouse) - private.reserved_quantity(p.id, v_warehouse, p_doc.id), 3)
               end) order by l.line_no)
        into v_lines
        from public.sales_order_lines l join public.products p on p.id = l.product_id
       where l.document_id = p_doc.id;
    when 'DELIVERY_NOTE' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', l.notes,
               'so_line_id', l.so_line_id, 'qty_ordered_so', sl.quantity, 'qty_delivered', sl.qty_delivered,
               'unit_price', sl.unit_price, 'unit_cost', l.unit_cost) order by l.line_no)
        into v_lines
        from public.delivery_note_lines l
        join public.products p on p.id = l.product_id
        join public.sales_order_lines sl on sl.id = l.so_line_id
       where l.document_id = p_doc.id;
      select x.warehouse_id into v_warehouse from public.delivery_notes x where x.document_id = p_doc.id;
      select d.* into v_order from public.delivery_notes x join public.documents d on d.id = x.sales_order_id
       where x.document_id = p_doc.id;
    when 'SALES_INVOICE' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', '',
               'so_line_id', l.so_line_id, 'qty_ordered_so', sl.quantity, 'qty_delivered', sl.qty_delivered,
               'unit_price', l.unit_price, 'vat_rate', l.vat_rate, 'line_subtotal', l.line_subtotal,
               'line_tax', l.line_tax, 'line_total', l.line_total) order by l.line_no)
        into v_lines
        from public.sales_invoice_lines l
        join public.products p on p.id = l.product_id
        join public.sales_order_lines sl on sl.id = l.so_line_id
       where l.document_id = p_doc.id;
      select d.* into v_order from public.sales_invoices x join public.documents d on d.id = x.sales_order_id
       where x.document_id = p_doc.id;
    when 'SALES_QUOTE' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', '',
               'unit_price', l.unit_price, 'list_price', l.list_price, 'vat_rate', l.vat_rate,
               'line_subtotal', l.line_subtotal, 'line_tax', l.line_tax, 'line_total', l.line_total) order by l.line_no)
        into v_lines
        from public.sales_quote_lines l join public.products p on p.id = l.product_id
       where l.document_id = p_doc.id;
      select x.warehouse_id into v_warehouse from public.sales_quotes x where x.document_id = p_doc.id;
    when 'PRODUCTION_ORDER' then
      select x.materials_warehouse_id into v_warehouse from public.production_orders x where x.document_id = p_doc.id;
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity_planned, 'notes', '',
               'planned_unit_cost', l.planned_unit_cost, 'qty_issued', l.quantity_issued, 'unit_cost', l.unit_cost,
               -- Mientras no se entregó: lo disponible en el depósito, sin lo reservado para otros.
               'qty_available', case when p_doc.status in ('BORRADOR', 'LIBERADA') then
                 round(private.on_hand_quantity(p.id, v_warehouse) - private.reserved_quantity(p.id, v_warehouse, p_doc.id), 3)
               end) order by l.line_no)
        into v_lines
        from public.production_order_lines l join public.products p on p.id = l.product_id
       where l.document_id = p_doc.id;
    else
      v_lines := null;
  end case;

  return jsonb_build_object(
    'doc', private.document_item(p_doc),
    'lines', coalesce(v_lines, '[]'),
    'journal', case when p_doc.doc_type = 'JOURNAL_ENTRY' then private.journal_view(p_doc) end,
    'payment', case when p_doc.doc_type = 'PAYMENT_ORDER' then private.payment_view(p_doc) end,
    'receipt', case when p_doc.doc_type = 'CUSTOMER_RECEIPT' then private.receipt_view(p_doc) end,
    'rfq', case when p_doc.doc_type = 'RFQ' then private.rfq_view(p_doc) end,
    'quote', case when p_doc.doc_type = 'SUPPLIER_QUOTE' then private.quote_view(p_doc) end,
    'transfer', case when p_doc.doc_type = 'FUNDS_TRANSFER' then private.transfer_view(p_doc) end,
    'reconciliation', case when p_doc.doc_type = 'BANK_RECONCILIATION' then private.reconciliation_view(p_doc) end,
    'sales_order', case when p_doc.doc_type = 'SALES_ORDER' then private.sales_order_view(p_doc) end,
    'sales_quote', case when p_doc.doc_type = 'SALES_QUOTE' then private.sales_quote_view(p_doc) end,
    'production_order', case when p_doc.doc_type = 'PRODUCTION_ORDER' then private.production_order_view(p_doc) end,
    'payroll', case when p_doc.doc_type = 'PAYROLL' then private.payroll_view(p_doc) end,
    'tax_return', case when p_doc.doc_type = 'TAX_RETURN' then private.tax_return_view(p_doc) end,
    'delivery', case when p_doc.doc_type = 'DELIVERY_NOTE' then private.delivery_view(p_doc) end,
    'supplier', (select to_jsonb(s) from public.suppliers s where s.id = p_doc.supplier_id),
    'customer', (select to_jsonb(c) from public.customers c where c.id = p_doc.customer_id),
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
                        array['PURCHASE_REQUISITION', 'RFQ', 'SUPPLIER_QUOTE', 'PURCHASE_ORDER', 'GOODS_RECEIPT',
                              'SUPPLIER_INVOICE', 'PAYMENT_ORDER', 'FUNDS_TRANSFER', 'BANK_RECONCILIATION', 'SALES_QUOTE', 'SALES_ORDER',
                              'DELIVERY_NOTE', 'SALES_INVOICE', 'CUSTOMER_RECEIPT', 'PRODUCTION_ORDER', 'PAYROLL', 'TAX_RETURN',
                              'STOCK_ADJUSTMENT', 'JOURNAL_ENTRY'],
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
      when 'SUPPLIER_INVOICE' then jsonb_build_array(
        private.signature(p_doc.id, 'Registró', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Controló', 'name', '', 'sector', '', 'at', ''))
      when 'PAYMENT_ORDER' then jsonb_build_array(
        private.signature(p_doc.id, 'Preparó', array['SUBMIT', 'CREATE']),
        private.signature(p_doc.id, 'Autorizó', array['APPROVE']),
        private.signature(p_doc.id, 'Pagó', array['PAY']))
      when 'RFQ' then jsonb_build_array(
        private.signature(p_doc.id, 'Preparó', array['SUBMIT', 'CREATE']),
        private.signature(p_doc.id, 'Adjudicó', array['AWARD']))
      when 'SUPPLIER_QUOTE' then jsonb_build_array(
        private.signature(p_doc.id, 'Cargó', array['CREATE']),
        jsonb_build_object('label', 'Controló', 'name', '', 'sector', '', 'at', ''))
      when 'FUNDS_TRANSFER' then jsonb_build_array(
        private.signature(p_doc.id, 'Preparó', array['CREATE']),
        private.signature(p_doc.id, 'Confirmó', array['CONFIRM']))
      when 'BANK_RECONCILIATION' then jsonb_build_array(
        private.signature(p_doc.id, 'Concilió', array['CREATE']),
        jsonb_build_object('label', 'Revisó', 'name', '', 'sector', '', 'at', ''))
      when 'SALES_ORDER' then jsonb_build_array(
        private.signature(p_doc.id, 'Vendió', array['CONFIRM', 'CREATE']),
        private.signature(p_doc.id, 'Autorizó el crédito', array['APPROVE']))
      when 'DELIVERY_NOTE' then jsonb_build_array(
        private.signature(p_doc.id, 'Despachó', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Recibió conforme (cliente)', 'name', '', 'sector', '', 'at', ''))
      when 'SALES_INVOICE' then jsonb_build_array(
        private.signature(p_doc.id, 'Emitió', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Controló', 'name', '', 'sector', '', 'at', ''))
      when 'CUSTOMER_RECEIPT' then jsonb_build_array(
        private.signature(p_doc.id, 'Preparó', array['CREATE']),
        private.signature(p_doc.id, 'Cobró', array['CONFIRM']))
      when 'SALES_QUOTE' then jsonb_build_array(
        private.signature(p_doc.id, 'Preparó', array['CREATE']),
        jsonb_build_object('label', 'Conformidad del cliente', 'name', '', 'sector', '', 'at', ''))
      when 'PRODUCTION_ORDER' then jsonb_build_array(
        private.signature(p_doc.id, 'Planificó', array['CREATE']),
        private.signature(p_doc.id, 'Entregó los materiales', array['ISSUE']),
        private.signature(p_doc.id, 'Terminó', array['FINISH']))
      when 'PAYROLL' then jsonb_build_array(
        private.signature(p_doc.id, 'Liquidó', array['CREATE']),
        private.signature(p_doc.id, 'Confirmó', array['CONFIRM']))
      when 'TAX_RETURN' then jsonb_build_array(
        private.signature(p_doc.id, 'Preparó', array['CREATE']),
        private.signature(p_doc.id, 'Presentó', array['CONFIRM']))
      else jsonb_build_array(
        private.signature(p_doc.id, 'Recibió / registró', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Controló', 'name', '', 'sector', '', 'at', ''))
    end
  );
end;
$$;

-- Igual que antes, y en la declaración de impuestos: SoD-10 al pagarla y sólo se anula la última (availableActions).
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
  v_account public.accounts;
  v_balance numeric;
  v_last public.documents;
  v_order public.documents;
  v_result jsonb := '[]';
begin
  select * into v_req from public.approval_requests a where a.document_id = p_doc.id and a.status = 'PENDIENTE';
  for v_tr in
    select * from public.document_transitions t
     where t.doc_type = p_doc.doc_type and t.from_status = p_doc.status and t.action <> 'SYSTEM'
     order by t.sort
  loop
    continue when v_tr.permission_code is null or not private.has_permission(p_doc.company_id, v_tr.permission_code);
    continue when v_result @> jsonb_build_array(jsonb_build_object('action', v_tr.action));
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
    if p_doc.doc_type = 'PAYMENT_ORDER' and v_tr.action in ('APPROVE', 'REJECT') and not v_supervisor and v_sod
       and p_doc.created_by = v_uid then
      v_reason := 'Separación de funciones: no podés aprobar ni rechazar una orden de pago que preparaste vos.';
    end if;
    if p_doc.doc_type = 'PAYMENT_ORDER' and v_tr.action = 'PAY' and not v_supervisor and v_sod
       and exists (select 1 from public.payment_order_lines l
                    where l.document_id = p_doc.id and private.invoice_registrant(l.invoice_id) = v_uid) then
      v_reason := 'Separación de funciones: registraste una de las facturas; tiene que pagarla otro integrante de Tesorería.';
    end if;
    if p_doc.doc_type = 'PAYROLL' and v_tr.action = 'PAY' and not v_supervisor and v_sod
       and v_uid = any (private.payroll_liquidators(p_doc)) then
      v_reason := 'Separación de funciones: liquidaste estos sueldos; tiene que pagarlos otro integrante de Tesorería.';
    end if;
    if p_doc.doc_type = 'TAX_RETURN' and v_tr.action = 'PAY' and not v_supervisor and v_sod
       and v_uid = any (private.tax_return_preparers(p_doc)) then
      v_reason := 'Separación de funciones: liquidaste este impuesto; tiene que pagarlo otro integrante de Tesorería.';
    end if;
    if p_doc.doc_type = 'TAX_RETURN' and v_tr.action = 'CANCEL' and p_doc.status <> 'BORRADOR'
       and (private.later_tax_return(p_doc)).id is not null then
      v_reason := format('Sólo se anula la última declaración de %s: %s es posterior.',
                         private.tax_name((select t.tax from public.tax_returns t where t.document_id = p_doc.id)),
                         (private.later_tax_return(p_doc)).display_number);
    end if;
    if p_doc.doc_type = 'RFQ' and v_tr.action = 'AWARD'
       and not exists (select 1 from private.rfq_quotes(p_doc.id) q where private.quote_is_valid(q.id)) then
      v_reason := 'Todavía no hay cotizaciones vigentes para adjudicar.';
    end if;
    if p_doc.doc_type = 'FUNDS_TRANSFER' and v_tr.action = 'CONFIRM' then
      select a.* into v_account from public.funds_transfers t join public.accounts a on a.id = t.from_account_id
       where t.document_id = p_doc.id;
      v_balance := private.account_balance(v_account.id);
      if p_doc.total > v_balance + 0.000000001 then
        v_reason := format('No alcanza el saldo de %s %s: hay %s.', v_account.code, v_account.name, private.format_money(v_balance));
      end if;
    end if;
    if p_doc.doc_type = 'FUNDS_TRANSFER' and p_doc.status = 'CONFIRMADA' and v_tr.action = 'CANCEL' then
      select a.* into v_account from public.funds_transfers t join public.accounts a on a.id = t.to_account_id
       where t.document_id = p_doc.id;
      v_balance := private.account_balance(v_account.id);
      if p_doc.total > v_balance + 0.000000001 then
        v_reason := format('Los fondos ya se usaron: en %s %s hay %s. Para devolverlos, prepará otra transferencia.',
                           v_account.code, v_account.name, private.format_money(v_balance));
      end if;
    end if;
    if p_doc.doc_type = 'BANK_RECONCILIATION' and v_tr.action = 'CANCEL' then
      v_last := private.last_reconciliation((select r.account_id from public.bank_reconciliations r where r.document_id = p_doc.id));
      if v_last.id is not null and v_last.id <> p_doc.id then
        v_reason := format('Sólo se anula la última conciliación de la cuenta (%s).', v_last.display_number);
      end if;
    end if;
    if p_doc.doc_type = 'SALES_ORDER' then
      v_reason := coalesce(private.sales_order_action_reason(p_doc, v_tr.action), v_reason);
    end if;
    if p_doc.doc_type = 'PRODUCTION_ORDER' and v_tr.action = 'RELEASE' and private.production_shortages(p_doc) is not null then
      v_reason := format('Faltan materiales: %s.', private.production_shortages(p_doc));
    end if;
    if p_doc.doc_type = 'SALES_QUOTE' then
      if v_tr.action in ('SEND', 'CONFIRM') and private.sales_quote_expired(p_doc) then
        v_reason := format('La oferta venció el %s: prepará otro presupuesto con los precios del día.',
                           (select to_char(q.valid_until, 'DD/MM/YYYY') from public.sales_quotes q where q.document_id = p_doc.id));
      end if;
      if v_tr.action = 'CLOSE' and not private.sales_quote_expired(p_doc) then
        v_reason := format('Vale hasta el %s: todavía no venció.',
                           (select to_char(q.valid_until, 'DD/MM/YYYY') from public.sales_quotes q where q.document_id = p_doc.id));
      end if;
    end if;
    if p_doc.doc_type = 'CUSTOMER_RECEIPT' and v_tr.action = 'CONFIRM' and not v_supervisor and v_sod
       and exists (select 1 from public.customer_receipt_lines l
                    where l.document_id = p_doc.id and private.invoice_registrant(l.invoice_id) = v_uid) then
      v_reason := 'Separación de funciones: emitiste una de las facturas; tiene que cobrarla otro integrante de Tesorería.';
    end if;
    if p_doc.doc_type = 'CUSTOMER_RECEIPT' and p_doc.status = 'CONFIRMADO' and v_tr.action = 'CANCEL' then
      select a.* into v_account from public.customer_receipts x join public.accounts a on a.id = x.treasury_account_id
       where x.document_id = p_doc.id;
      v_balance := private.account_balance(v_account.id);
      if p_doc.total > v_balance + 0.000000001 then
        v_reason := format('Los fondos ya se usaron: en %s %s hay %s. Primero hay que anular el movimiento que los usó.',
                           v_account.code, v_account.name, private.format_money(v_balance));
      end if;
    end if;
    if p_doc.doc_type = 'DELIVERY_NOTE' and p_doc.status = 'CONFIRMADO' and v_tr.action = 'CANCEL' then
      select d.* into v_order from public.delivery_notes x join public.documents d on d.id = x.sales_order_id
       where x.document_id = p_doc.id;
      if v_sod and not v_supervisor and not ('GERENCIA' = any (v_roles)) and private.invoice_registrant(p_doc.id) = v_uid then
        v_reason := 'Separación de funciones: otro integrante de Depósito o Gerencia debe anularlo.';
      elsif v_order.status = 'CERRADO' then
        v_reason := format('%s está cerrado: ya no se anula el remito.', v_order.display_number);
      end if;
    end if;
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'action', v_tr.action, 'label', v_tr.label, 'help', v_tr.help_text, 'tone', v_tr.tone,
      'requires_comment', v_tr.requires_comment, 'enabled', v_reason is null, 'reason', v_reason));
  end loop;
  return v_result;
end;
$$;
