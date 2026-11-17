-- 101. Fase 8e.1 (docs/FASE_8_BANCO_Y_FISCO.md §4): la recepción de las declaraciones en el fisco.
-- Presentada, la declaración queda Enviada al fisco; quien opera el fisco (Impuestos, fisco.operate),
-- que no la preparó ni la presentó (SoD-15), la acepta con un acuse (SIM-DJ-, la fecha y un
-- correlativo de la empresa) —queda Presentada o Presentada sin saldo y se registra el asiento del
-- impuesto— o la observa con el motivo: hay que anularla y presentarla de nuevo. Al presentarla, el
-- fisco calcula su control cruzado con los comprobantes de venta que autorizó en el mes. Si el fisco
-- lo opera el sistema, o si el docente bloqueó su módulo, la recibe en el momento: la acepta si el
-- control coincide y la observa si no (lo mismo con los puntos de venta). Traducción de "Impuestos"
-- y "Puntos de venta" de engine.ts (8e.1).
--
-- Los estados, las transiciones y las tareas nuevos están en la migración de catálogos siguiente.

-- ------------------------------------------------------------------ Tablas

alter table public.tax_returns
  add column control_amount numeric(14, 2),
  add column transaction_code text check (transaction_code ~ '^SIM-DJ-[0-9]{14}$'),
  add column received_on date,
  add column received_by uuid;
create unique index tax_returns_transaction_idx on public.tax_returns (company_id, transaction_code)
  where transaction_code is not null;

-- ------------------------------------------------------------------ Auxiliares

-- El fisco responde solo si lo opera el sistema o si el docente bloqueó su módulo (fiscoAutomatic).
create function private.fisco_automatic(p_company uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select private.fisco_mode(p_company) = 'AUTOMATICO' or not private.module_enabled(p_company, 'fisco') $$;

-- El control cruzado del fisco: con los comprobantes de venta que autorizó en el mes, menos los
-- anulados en el mes, el IVA (para el débito fiscal) o las ventas netas (para la base de ingresos
-- brutos) (fiscoControl).
create function private.fisco_control(p_company uuid, p_tax text, p_period text)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_tax = 'IVA' then coalesce(round(sum(e.vat), 2), 0)
              else greatest(coalesce(round(sum(e.net + e.exempt), 2), 0), 0) end
    from private.iva_book_entries(p_company, p_period, true) e
    join public.sales_invoices f on f.document_id = e.invoice_id and f.authorization_code is not null
$$;

-- El acuse del fisco: SIM-DJ-, la fecha y el correlativo de la empresa (taxReturnAcuse).
create function private.tax_return_acuse(p_company uuid, p_today date)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select 'SIM-DJ-' || to_char(p_today, 'YYYYMMDD')
         || lpad((coalesce(max(right(t.transaction_code, 6)::int), 0) + 1)::text, 6, '0')
    from public.tax_returns t
   where t.company_id = p_company and t.transaction_code is not null
$$;

-- Cómo la recibe el sistema: null si la acepta (el control cruzado coincide); si no, el motivo con la
-- diferencia (systemReception).
create function private.tax_return_system_reason(p_doc uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when abs(round(case when t.tax = 'IVA' then t.tax_amount else coalesce(t.base, 0) end
                   - coalesce(t.control_amount, 0), 2)) < 0.000000001 then null
    when t.tax = 'IVA' then format(
      'El control cruzado no coincide: el débito fiscal declarado es %s y el de los comprobantes autorizados del mes, %s.',
      private.format_money(t.tax_amount), private.format_money(coalesce(t.control_amount, 0)))
    else format(
      'El control cruzado no coincide: la base declarada es %s y la de los comprobantes autorizados del mes, %s.',
      private.format_money(coalesce(t.base, 0)), private.format_money(coalesce(t.control_amount, 0)))
  end
    from public.tax_returns t
   where t.document_id = p_doc
$$;

-- El asiento del impuesto, al aceptarla el fisco: del crédito fiscal (o de las percepciones y
-- retenciones) se usa hasta el impuesto; lo que sobra queda en la cuenta como saldo a favor
-- (postTaxReturnEntry).
create function private.tax_return_post_entry(p_actor private.actor, p_doc uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_t public.tax_returns;
  v_month text;
  v_used numeric;
  v_previous text;
begin
  select * into v_doc from public.documents d where d.id = p_doc;
  select * into v_t from public.tax_returns t where t.document_id = p_doc;
  if not v_t.tax_amount > 0 then
    return;
  end if;
  v_month := private.period_label(v_t.period);
  v_used := least(v_t.tax_amount, round(v_t.credits + v_t.previous_balance, 2));
  v_previous := case when v_t.previous_balance <> 0
    then format(' y saldo a favor anterior %s', private.format_money(v_t.previous_balance)) else '' end;
  if v_t.tax = 'IVA' then
    perform private.post_event(p_actor, v_doc, 'IVA',
      format('IVA de %s (%s): débito fiscal %s, crédito fiscal %s%s.', v_month, v_doc.display_number,
             private.format_money(v_t.tax_amount), private.format_money(v_t.credits), v_previous),
      jsonb_build_array(
        jsonb_build_object('key', 'IVA_DEBITO', 'debit', v_t.tax_amount, 'credit', 0),
        jsonb_build_object('key', 'IVA_CREDITO', 'debit', 0, 'credit', v_used),
        jsonb_build_object('key', 'IVA_A_PAGAR', 'debit', 0, 'credit', v_doc.total)));
  else
    perform private.post_event(p_actor, v_doc, 'IIBB',
      format('Ingresos brutos de %s (%s): impuesto %s, percepciones y retenciones %s%s.', v_month, v_doc.display_number,
             private.format_money(v_t.tax_amount), private.format_money(v_t.credits), v_previous),
      jsonb_build_array(
        jsonb_build_object('key', 'IMPUESTO', 'debit', v_t.tax_amount, 'credit', 0),
        jsonb_build_object('key', 'RETENCIONES', 'debit', 0, 'credit', v_used),
        jsonb_build_object('key', 'IIBB_A_PAGAR', 'debit', 0, 'credit', v_doc.total)));
  end if;
end;
$$;

-- El fisco recibe la declaración. Sin motivo, la acepta: el acuse y el asiento del impuesto; queda
-- Presentada o, sin saldo a pagar, Presentada sin saldo. Con motivo, la observa. Con p_presenting (el
-- resumen de la presentación) la recibe el sistema al presentarla, en la misma transición (CONFIRM);
-- si no, estaba enviada (APPROVE o REJECT) (receiveTaxReturn).
create function private.tax_return_receive_doc(p_doc uuid, p_reason text, p_actor private.actor, p_received_by uuid,
                                               p_presenting text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_today date;
  v_code text;
begin
  select * into v_doc from public.documents d where d.id = p_doc;
  v_today := private.business_date(v_doc.company_id);
  if p_reason is not null then
    perform private.transition_document(v_doc.id, case when p_presenting is not null then 'CONFIRM' else 'REJECT' end,
      p_reason, p_to => 'OBSERVADA', p_actor => p_actor,
      p_summary => case when p_presenting is not null then format('%s; el fisco la observó: %s', p_presenting, p_reason)
                        else format('Observó en el fisco %s: %s', v_doc.display_number, p_reason) end);
    update public.documents set status_reason = p_reason where id = v_doc.id;
    update public.tax_returns set received_on = v_today, received_by = p_received_by where document_id = v_doc.id;
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('fisco_acuse:' || v_doc.company_id, 0));
  v_code := private.tax_return_acuse(v_doc.company_id, v_today);
  perform private.transition_document(v_doc.id, case when p_presenting is not null then 'CONFIRM' else 'APPROVE' end,
    p_to => case when v_doc.total > 0 then 'PRESENTADA' else 'SIN_SALDO' end, p_actor => p_actor,
    p_summary => case when p_presenting is not null then format('%s; el fisco la aceptó con el acuse %s', p_presenting, v_code)
                      else format('Aceptó en el fisco %s con el acuse %s', v_doc.display_number, v_code) end);
  update public.tax_returns set transaction_code = v_code, received_on = v_today, received_by = p_received_by
   where document_id = v_doc.id;
  perform private.tax_return_post_entry(p_actor, v_doc.id);
end;
$$;

-- ------------------------------------------------------------------ Comandos

-- Presentar: queda fijo lo declarado y la declaración va al fisco, que calcula su control cruzado. Si
-- el fisco lo opera Impuestos, espera que la reciba; si lo opera el sistema (o su módulo está
-- bloqueado), la recibe en el momento (cmdPresentTaxReturn).
create or replace function public.tax_return_present(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_actor private.actor;
  v_t public.tax_returns;
  v_what text;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'TAX_RETURN');
  perform private.require_transition(v_doc, 'CONFIRM');
  v_actor := private.require_permission(v_doc.company_id, 'tax_return.create');
  select * into v_t from public.tax_returns t where t.document_id = v_doc.id;
  update public.tax_returns
     set presented_at = now(), control_amount = private.fisco_control(v_doc.company_id, v_t.tax, v_t.period)
   where document_id = v_doc.id;
  v_what := format('%s de %s, %s', private.tax_name(v_t.tax), private.period_label(v_t.period),
                   case when v_doc.total > 0 then format('%s a pagar', private.format_money(v_doc.total))
                        else 'sin saldo a pagar' end);
  if private.fisco_automatic(v_doc.company_id) then
    perform private.tax_return_receive_doc(v_doc.id, private.tax_return_system_reason(v_doc.id), v_actor, null,
                                           format('Presentó %s: %s', v_doc.display_number, v_what));
  else
    perform private.transition_document(v_doc.id, 'CONFIRM', p_to => 'ENVIADA', p_actor => v_actor,
      p_summary => format('Presentó %s al fisco: %s', v_doc.display_number, v_what));
  end if;
end;
$$;

-- Quien opera el fisco recibe una declaración enviada: la acepta con el acuse o la observa con el
-- motivo. No la recibe quien la preparó o la presentó (SoD-15). p_input: {accept, reason}
-- (cmdReceiveTaxReturn).
create function public.tax_return_receive(p_document_id uuid, p_input jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_accept boolean := coalesce((p_input ->> 'accept')::boolean, false);
  v_actor private.actor;
  v_sod boolean;
  v_reason text;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'TAX_RETURN');
  perform private.require_transition(v_doc, case when v_accept then 'APPROVE' else 'REJECT' end);
  v_actor := private.require_permission(v_doc.company_id, 'fisco.operate');
  v_sod := coalesce((select (c.settings ->> 'sod_enabled')::boolean from public.companies c
                     where c.id = v_doc.company_id), true)
           and not private.is_supervisor(v_doc.company_id);
  if v_sod and (select auth.uid()) = any (private.tax_return_preparers(v_doc)) then
    perform private.raise_business_error('SEPARACION_FUNCIONES',
      format('No podés recibir %s en el fisco: la preparaste o la presentaste vos.', v_doc.display_number),
      'Separación de funciones (SoD-15): quien liquida un impuesto no recibe su declaración en el fisco. La recibe otro integrante de Impuestos.');
  end if;
  if v_accept then
    perform private.tax_return_receive_doc(v_doc.id, null, v_actor, (select auth.uid()), null);
    return;
  end if;
  v_reason := btrim(coalesce(p_input ->> 'reason', ''));
  if length(v_reason) < 3 then
    perform private.raise_business_error('MOTIVO_REQUERIDO', 'Indicá el motivo de la observación: lo recibe Impuestos.');
  end if;
  perform private.tax_return_receive_doc(v_doc.id, v_reason, v_actor, (select auth.uid()), null);
end;
$$;

grant execute on function public.tax_return_receive(uuid, jsonb) to authenticated;

-- ------------------------------------------------------------------ Versiones nuevas

-- Igual que antes, y la de un mes se prepara con la anterior ya recibida por el fisco: si está
-- enviada, hay que esperar; si la observó, primero se presenta de nuevo (cmdCreateTaxReturn).
create or replace function public.tax_return_create(p_company_id uuid, p_input jsonb)
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
  v_base numeric;
  v_rate numeric;
  v_doc public.documents;
begin
  select * into v_company from public.companies c where c.id = p_company_id;
  if v_tax not in ('IVA', 'IIBB') then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el impuesto: IVA o ingresos brutos.');
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
  if v_last.status = 'ENVIADA' then
    perform private.raise_business_error('DATO_INVALIDO',
      format('%s (%s de %s) está en el fisco: hay que esperar que la reciba.', v_last.display_number, v_name,
             private.period_label(v_last_period)));
  end if;
  if v_last.status = 'OBSERVADA' then
    perform private.raise_business_error('DATO_INVALIDO',
      format('El fisco observó %s (%s de %s): primero hay que anularla y presentarla de nuevo.', v_last.display_number,
             v_name, private.period_label(v_last_period)));
  end if;
  if length(v_notes) > 500 then
    perform private.raise_business_error('DATO_INVALIDO', 'Las observaciones tienen hasta 500 caracteres.');
  end if;
  if v_tax = 'IVA' then
    v_debit := private.iva_book_vat(p_company_id, v_period, true);
    v_credit := private.iva_book_vat(p_company_id, v_period, false);
  else
    -- Si en el mes se anuló más de lo que se vendió, la base es cero (a validar).
    select greatest(coalesce(round(sum(e.net + e.exempt), 2), 0), 0) into v_base
      from private.iva_book_entries(p_company_id, v_period, true) e;
    v_rate := coalesce((v_company.settings ->> 'iibb_pct')::numeric, private.iibb_default_pct());
    v_debit := round(v_base * v_rate / 100, 2);
    select coalesce(round(sum(c.amount), 2), 0) into v_credit from private.iibb_credits(p_company_id, v_period) c;
  end if;
  v_previous := coalesce(v_last_balance, 0);
  v_result := round(v_debit - v_credit - v_previous, 2);
  v_doc := private.new_document(p_company_id, 'TAX_RETURN', v_actor, null, v_notes);
  insert into public.tax_returns (document_id, company_id, tax, period, due_date, tax_amount, credits, previous_balance,
                                  balance_in_favor, base, rate)
  values (v_doc.id, p_company_id, v_tax, v_period,
          private.next_month_day(v_period, case when v_tax = 'IVA' then 20 else 15 end),
          v_debit, v_credit, v_previous, greatest(-v_result, 0), v_base, v_rate);
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

-- Igual que antes, y además recibe las declaraciones enviadas cuando el fisco pasa al sistema o se
-- bloquea su módulo (settleFisco).
create or replace function private.fisco_settle(p_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pos uuid;
  v_dj uuid;
begin
  if private.fisco_automatic(p_company) then
    for v_pos in
      select p.id from public.points_of_sale p
       where p.company_id = p_company and p.status = 'SOLICITADO' order by p.number
    loop
      perform private.pos_decide(v_pos, null, null);
    end loop;
    for v_dj in
      select d.id from public.documents d
       where d.company_id = p_company and d.doc_type = 'TAX_RETURN' and d.status = 'ENVIADA' order by d.number
    loop
      perform private.tax_return_receive_doc(v_dj, private.tax_return_system_reason(v_dj), row(null, 'Sistema', 'SISTEMA', null, '—')::private.actor, null, null);
    end loop;
  end if;
  perform private.pos_sync_task(p_company);
end;
$$;

-- Igual que antes, salvo que con el módulo del fisco bloqueado también lo habilita en el momento
-- (cmdRequestPointOfSale).
create or replace function public.point_of_sale_request(p_company_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'sales_invoice.create');
  v_description text := btrim(coalesce(p_input ->> 'description', ''));
  v_waiting text;
  v_pos public.points_of_sale;
begin
  if length(v_description) < 3 or length(v_description) > 60 then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá para qué es el punto de venta (de 3 a 60 caracteres).');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('point_of_sale:' || p_company_id, 0));
  select p.number into v_waiting from public.points_of_sale p
   where p.company_id = p_company_id and p.status = 'SOLICITADO' order by p.number limit 1;
  if v_waiting is not null then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('El punto de venta %s todavía espera la respuesta del fisco: se pide de a uno.', v_waiting));
  end if;
  insert into public.points_of_sale (company_id, number, description, requested_by, requested_on)
  values (p_company_id,
          lpad((coalesce((select max(p.number::int) from public.points_of_sale p where p.company_id = p_company_id), 0)
                + 1)::text, 5, '0'),
          v_description, (select auth.uid()), private.business_date(p_company_id))
  returning * into v_pos;
  perform private.log_audit(p_company_id, v_actor, 'REQUEST', 'point_of_sale', v_pos.id, 'Punto de venta ' || v_pos.number,
    format('Pidió al fisco habilitar el punto de venta %s: %s', v_pos.number, v_description));
  if private.fisco_automatic(p_company_id) then
    perform private.pos_decide(v_pos.id, null, null);
  end if;
  perform private.pos_sync_task(p_company_id);
  return jsonb_build_object('id', v_pos.id, 'number', v_pos.number,
                            'status', (select p.status from public.points_of_sale p where p.id = v_pos.id));
end;
$$;

-- Igual que antes, salvo que con el módulo del fisco bloqueado no hay tarea (syncPointOfSaleTask).
create or replace function private.pos_sync_task(p_company uuid)
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
   where t.company_id = p_company and t.task_type = 'HABILITAR_PUNTO_VENTA' and t.status in ('PENDIENTE', 'EN_CURSO')
   order by t.created_at limit 1;
  if private.fisco_automatic(p_company)
     or not exists (select 1 from public.points_of_sale p where p.company_id = p_company and p.status = 'SOLICITADO') then
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
  values (p_company, 'HABILITAR_PUNTO_VENTA', 'Habilitar el punto de venta que pidió Ventas',
          'Ventas pidió habilitar un punto de venta: lo habilita o lo rechaza, desde Fisco simulado → Puntos de venta, un integrante de Impuestos que no lo pidió.',
          '{}', 'IMPUESTOS', 'NORMAL')
  returning id into v_task;
  perform private.notify_roles(
    p_company, array['IMPUESTOS'], 'NUEVA_TAREA', 'Pedido de punto de venta',
    'Ventas pidió habilitar un punto de venta: habilitalo o rechazalo desde Fisco simulado → Puntos de venta.',
    '/e/' || (select c.slug from public.companies c where c.id = p_company) || '/fisco/puntos-de-venta', null, v_task
  );
end;
$$;

-- Igual que antes, y al bloquear o habilitar el módulo del fisco, el fisco se pone al día (cmdSetModule).
create or replace function public.company_set_module(p_company_id uuid, p_module text, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_supervisor(p_company_id);
  v_name text;
begin
  select mo.name into v_name from public.modules mo where mo.code = p_module and mo.is_lockable;
  if v_name is null then
    perform private.raise_business_error('DATO_INVALIDO', 'Ese módulo no se puede bloquear.');
  end if;
  insert into public.company_modules (company_id, module_code, is_enabled, updated_at, updated_by)
  values (p_company_id, p_module, p_enabled, now(), (select auth.uid()))
  on conflict (company_id, module_code) do update
    set is_enabled = excluded.is_enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  -- Bloqueado, el fisco responde solo (8e.1): recibe lo que esperaba; habilitado, vuelven sus tareas.
  if p_module = 'fisco' then
    perform private.fisco_settle(p_company_id);
  end if;
  perform private.log_audit(p_company_id, v_actor, 'SETTINGS', 'company_module', p_company_id, v_name,
    format('%s el módulo %s', case when p_enabled then 'Habilitó' else 'Bloqueó' end, v_name));
end;
$$;

-- Igual que antes, y la separación de funciones al recibir una declaración en el fisco (SoD-15).
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
    if p_doc.doc_type = 'PAYROLL' and v_tr.action in ('APPROVE', 'REJECT') and not v_supervisor and v_sod
       and p_doc.created_by = v_uid then
      v_reason := 'Separación de funciones: no podés autorizar ni devolver una liquidación que preparaste vos.';
    end if;
    if p_doc.doc_type = 'PAYROLL' and v_tr.action = 'PAY' and not v_supervisor and v_sod
       and v_uid = any (private.payroll_liquidators(p_doc)) then
      v_reason := 'Separación de funciones: liquidaste estos sueldos; tiene que pagarlos otro integrante de Tesorería.';
    end if;
    if p_doc.doc_type = 'TAX_RETURN' and v_tr.action = 'PAY' and not v_supervisor and v_sod
       and v_uid = any (private.tax_return_preparers(p_doc)) then
      v_reason := 'Separación de funciones: liquidaste este impuesto; tiene que pagarlo otro integrante de Tesorería.';
    end if;
    if p_doc.doc_type = 'TAX_RETURN' and v_tr.action in ('APPROVE', 'REJECT') and not v_supervisor and v_sod
       and v_uid = any (private.tax_return_preparers(p_doc)) then
      v_reason := 'Separación de funciones: la preparaste o la presentaste vos; la recibe otro integrante de Impuestos.';
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

-- Igual que antes, y qué sigue con la declaración enviada al fisco y con la observada (nextStep).
create or replace function private.next_step(p_doc public.documents)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sector text := coalesce((select s.name from public.sectors s where s.id = p_doc.sector_id), 'el sector solicitante');
  v_route public.route_sheet_lines;
  v_route_number text;
  v_delivery text;
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
        'text', case when p_doc.status_reason <> ''
          then format('Gerencia la devolvió: "%s". Corregir las novedades y volver a enviarla a autorizar.',
                      p_doc.status_reason)
          else 'Cargar las novedades del mes de cada empleado (los días o las horas trabajadas, las ausencias sin aviso y las horas extra), revisar los recibos y enviar la liquidación a Gerencia para que la autorice.'
        end);
    when 'PAYROLL:PENDIENTE_APROBACION' then
      return jsonb_build_object('who', 'Gerencia',
        'text', format('Revisar los recibos y los totales (%s netos) y autorizar la liquidación: se registra el asiento de sueldos y Tesorería recibe la tarea de pagar. Si hay que corregir algo, devolverla a RRHH con el motivo.',
                       private.format_money(p_doc.total)));
    when 'PAYROLL:CONFIRMADA' then
      return jsonb_build_object('who', 'Tesorería',
        'text', format('Pagar los sueldos el %s: %s netos. Los aportes retenidos y las contribuciones quedan en Cargas sociales a pagar hasta que se depositen.',
                       coalesce((select to_char(x.payment_date, 'DD/MM/YYYY') from public.payrolls x
                                  where x.document_id = p_doc.id), '—'),
                       private.format_money(p_doc.total)));
    when 'PAYROLL:SUELDOS_PAGADOS' then
      return (
        select jsonb_build_object('who', 'Tesorería',
          'text', format('Pagar las cargas sociales antes del %s: %s entre los aportes retenidos a los empleados, las contribuciones de la empresa y lo de los sindicatos.',
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
      v_delivery := private.delivery_status(p_doc.id);
      v_route := private.last_route_line(p_doc.id);
      v_route_number := (select d.display_number from public.documents d where d.id = v_route.document_id);
      if v_delivery = 'PROGRAMADO' then
        return jsonb_build_object('who', 'Logística',
          'text', format('Está en la hoja de ruta %s, que todavía no salió.', v_route_number));
      elsif v_delivery = 'EN_CAMINO' then
        return jsonb_build_object('who', 'Logística',
          'text', format('Va en camino al cliente con la hoja de ruta %s: al volver, Logística la rinde.', v_route_number));
      elsif v_delivery = 'ENTREGADO' then
        return jsonb_build_object('who', '—',
          'text', format('Entregado con la hoja de ruta %s: lo recibió %s.', v_route_number, v_route.received_by));
      end if;
      return jsonb_build_object('who', 'Logística',
        'text', case when v_route.id is not null
          then format('No se entregó con %s: %s. Logística lo incluye en otra hoja de ruta.', v_route_number, v_route.reason)
          else 'La mercadería salió del depósito (bajó el stock y se registró el costo de lo vendido). Falta llevarla al cliente: Logística la incluye en una hoja de ruta.' end);
    when 'ROUTE_SHEET:BORRADOR' then
      return jsonb_build_object('who', 'Logística',
        'text', 'Cargar la mercadería de los remitos en el orden de visita, controlar el transporte y salir a repartir: los remitos pasan a "en camino".');
    when 'ROUTE_SHEET:EN_CAMINO' then
      return jsonb_build_object('who', 'Logística',
        'text', 'Al volver, rendir la hoja: qué remitos se entregaron (y quién los recibió) y cuáles no (y por qué). Ventas recibe un aviso por cada uno.');
    when 'TAX_RETURN:BORRADOR' then
      return jsonb_build_object('who', 'Impuestos',
        'text', case when (select t.tax from public.tax_returns t where t.document_id = p_doc.id) = 'IIBB'
          then 'Revisar las ventas netas del mes y las percepciones y retenciones sufridas, y presentar la declaración: se registra el asiento del impuesto.'
          else 'Revisar los libros IVA del mes (el débito y el crédito fiscal) y presentar la declaración: se registra el asiento del impuesto.' end);
    when 'TAX_RETURN:ENVIADA' then
      return jsonb_build_object('who', 'Fisco (Impuestos)',
        'text', 'El fisco la recibe: controla lo declarado con los comprobantes que autorizó en el mes y la acepta con un acuse (se registra el asiento del impuesto) o la observa con el motivo. No la recibe quien la preparó o la presentó.');
    when 'TAX_RETURN:OBSERVADA' then
      return jsonb_build_object('who', 'Impuestos',
        'text', 'El fisco la observó' || coalesce(' con este motivo: «' || nullif(p_doc.status_reason, '') || '»', '')
                || '. Hay que anularla y presentarla de nuevo.');
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

-- Igual que antes: la declaración enviada al fisco o la observada todavía no cumplen la obligación
-- (obligationsCalendar).
create or replace function public.obligations_calendar(p_company_id uuid, p_period text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_start date;
  v_today date;
  v_month text;
  v_payroll public.documents;
  v_p public.payrolls;
  v_waiting text;
  v_salaries_paid boolean;
  v_rows jsonb := '[]';
  v_tax text;
  v_dj public.documents;
  v_t public.tax_returns;
begin
  perform private.require_read(p_company_id, 'tax_return.read');
  if coalesce(p_period, '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    perform private.raise_business_error('DATO_INVALIDO', 'El período es un mes: aaaa-mm.');
  end if;
  select c.start_date into v_start from public.companies c where c.id = p_company_id;
  if p_period < to_char(v_start, 'YYYY-MM') then
    perform private.raise_business_error('DATO_INVALIDO',
      format('La empresa empezó sus actividades el %s: no hay obligaciones antes.', to_char(v_start, 'DD/MM/YYYY')));
  end if;
  v_today := private.business_date(p_company_id);
  v_month := private.period_label(p_period);
  if private.has_permission(p_company_id, 'payroll.read') then
    select d.* into v_payroll
      from public.documents d join public.payrolls p on p.document_id = d.id
     where d.company_id = p_company_id and d.status <> 'ANULADA' and p.period = p_period
     order by d.number
     limit 1;
    select * into v_p from public.payrolls p where p.document_id = v_payroll.id;
    -- Lo que falta antes de pagar: liquidarla o que Gerencia la autorice.
    v_waiting := case when v_payroll.id is null then 'Sin liquidar'
                      when v_payroll.status = 'BORRADOR' then v_payroll.display_number || ' en borrador'
                      when v_payroll.status = 'PENDIENTE_APROBACION'
                        then v_payroll.display_number || ' espera la autorización de Gerencia' end;
    v_salaries_paid := coalesce(v_payroll.status in ('SUELDOS_PAGADOS', 'PAGADA'), false);
    v_rows := v_rows || jsonb_build_array(
      jsonb_build_object(
        'kind', 'SUELDOS', 'label', 'Sueldos de ' || v_month,
        'due_date', coalesce(v_p.payment_date, private.next_month_day(p_period, 4)),
        'status', case when v_waiting is not null then 'PENDIENTE' when v_salaries_paid then 'CUMPLIDA' else 'A_PAGAR' end,
        'detail', coalesce(v_waiting, case when v_salaries_paid
                                        then 'Pagados el ' || to_char(v_p.salaries_paid_on, 'DD/MM/YYYY')
                                        else 'Autorizada: falta pagar los sueldos' end),
        'amount', v_payroll.total,
        'document', case when v_payroll.id is not null then jsonb_build_object(
          'id', v_payroll.id, 'display_number', v_payroll.display_number, 'path', private.doc_path(v_payroll.id)) end),
      jsonb_build_object(
        'kind', 'CARGAS_SOCIALES', 'label', 'Cargas sociales de ' || v_month,
        'due_date', private.payroll_charges_due(p_period),
        'status', case when v_waiting is not null then 'PENDIENTE' when v_payroll.status = 'PAGADA' then 'CUMPLIDA'
                       else 'A_PAGAR' end,
        'detail', coalesce(v_waiting, case when v_payroll.status = 'PAGADA'
                                        then 'Pagadas el ' || to_char(v_p.charges_paid_on, 'DD/MM/YYYY')
                                        else 'Falta pagarlas' end),
        'amount', case when v_payroll.id is not null then private.payroll_charges(v_payroll.id) end,
        'document', case when v_payroll.id is not null then jsonb_build_object(
          'id', v_payroll.id, 'display_number', v_payroll.display_number, 'path', private.doc_path(v_payroll.id)) end));
  end if;
  foreach v_tax in array array['IIBB', 'IVA'] loop
    select d.* into v_dj
      from public.documents d join public.tax_returns t on t.document_id = d.id
     where d.company_id = p_company_id and d.status <> 'ANULADA' and t.tax = v_tax and t.period = p_period
     order by d.number
     limit 1;
    select * into v_t from public.tax_returns t where t.document_id = v_dj.id;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'kind', v_tax, 'label', case when v_tax = 'IVA' then 'IVA' else 'Ingresos brutos' end || ' de ' || v_month,
      'due_date', private.next_month_day(p_period, case when v_tax = 'IVA' then 20 else 15 end),
      'status', case when v_dj.id is null or v_dj.status in ('BORRADOR', 'ENVIADA', 'OBSERVADA') then 'PENDIENTE'
                     when v_dj.status = 'PRESENTADA' then 'A_PAGAR' else 'CUMPLIDA' end,
      'detail', case when v_dj.id is null then 'Sin declarar'
                     when v_dj.status = 'BORRADOR' then v_dj.display_number || ' en borrador'
                     when v_dj.status = 'ENVIADA' then 'Enviada al fisco: espera el acuse'
                     when v_dj.status = 'OBSERVADA' then 'Observada por el fisco: hay que presentarla de nuevo'
                     when v_dj.status = 'PRESENTADA' then 'Presentada: falta pagarla'
                     when v_dj.status = 'SIN_SALDO' then 'Presentada sin saldo a pagar'
                     else 'Pagada el ' || to_char(v_t.paid_on, 'DD/MM/YYYY') end,
      'amount', v_dj.total,
      'document', case when v_dj.id is not null then jsonb_build_object(
        'id', v_dj.id, 'display_number', v_dj.display_number, 'path', private.doc_path(v_dj.id)) end));
  end loop;
  return jsonb_build_object(
    'period', p_period,
    'rows', coalesce((
      select jsonb_agg(r || jsonb_build_object('overdue', (r ->> 'due_date')::date < v_today and r ->> 'status' <> 'CUMPLIDA')
                       order by r ->> 'due_date', array_position(array['SUELDOS', 'CARGAS_SOCIALES', 'IIBB', 'IVA'], r ->> 'kind'))
        from jsonb_array_elements(v_rows) as r), '[]'));
end;
$$;

-- Igual que antes, y en la declaración, lo del fisco: el control cruzado, el acuse y la recepción
-- (document_json).
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
               'invoice_number', x.invoice_number, 'due_date', x.due_date, 'registered_at', x.registered_at,
               'perception', x.perception))
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
               'invoice_number', x.invoice_number, 'due_date', x.due_date, 'registered_at', x.registered_at,
               'authorization_code', x.authorization_code, 'authorization_due', x.authorization_due))
        from public.sales_invoices x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('rc', jsonb_build_object(
               'treasury_account_id', x.treasury_account_id, 'payment_method', x.payment_method, 'reference', x.reference,
               'received_on', x.received_on, 'retention', x.retention))
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
               'presented_at', x.presented_at, 'paid_on', x.paid_on, 'paid_account_id', x.paid_account_id,
               'base', x.base, 'rate', x.rate, 'control_amount', x.control_amount, 'transaction_code', x.transaction_code,
               'received_on', x.received_on, 'received_by', x.received_by))
        from public.tax_returns x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('rs', jsonb_build_object(
               'carrier_id', x.carrier_id, 'vehicle_id', x.vehicle_id, 'driver_id', x.driver_id,
               'departed_at', x.departed_at, 'closed_at', x.closed_at))
        from public.route_sheets x where x.document_id = p_doc.id), '{}')
$$;
