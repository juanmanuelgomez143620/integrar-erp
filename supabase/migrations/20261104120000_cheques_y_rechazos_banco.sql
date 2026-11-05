-- 87. Fase 8b.2 (docs/FASE_8_BANCO_Y_FISCO.md §3): los cheques al cobro y el rechazo por falta de
-- fondos en el Banco Aula. El pago de una orden de pago con cheque llega al banco con su número y se
-- presenta al cobro tres días después: antes no entra en "procesar todas" y, si lo opera el sistema,
-- espera su fecha y se cobra la próxima vez que el banco mueve la cuenta. Una orden que saca más que
-- el saldo según el banco más el acuerdo de descubierto se rechaza: no se debita, el banco cobra la
-- comisión por rechazo (2.500; 4.000 un cheque) y Tesorería recibe el aviso y una tarea, que resuelve
-- anulando la operación o reenviando la orden cuando hay fondos. Además, cambiar el control interno
-- ya no procesa lo pendiente del banco: sólo lo hace pasar al sistema. Traducción de la sección
-- "Banco Aula" de engine.ts (8b.2).

-- ------------------------------------------------------------------ Tablas

alter table public.bank_movements
  add column cheque_number text,
  add column presented_on date,
  add constraint bank_movements_cheque check ((cheque_number is null) = (presented_on is null));
alter table public.bank_movements drop constraint bank_movements_status_check;
alter table public.bank_movements add constraint bank_movements_status_check
  check (status in ('PENDIENTE', 'PROCESADO', 'RECHAZADO', 'ANULADO'));
-- La fecha de proceso es también la del rechazo; una orden rechazada que después se anula la conserva.
alter table public.bank_movements drop constraint bank_movements_check;
alter table public.bank_movements add constraint bank_movements_processed_on check (
  case status when 'PENDIENTE' then processed_on is null
              when 'ANULADO' then true
              else processed_on is not null end);

-- ------------------------------------------------------------------ Auxiliares

-- Mientras haya órdenes rechazadas, Tesorería tiene una tarea abierta para resolverlas: anular la
-- operación y volver a pagar, o reenviarlas cuando haya fondos. Devuelve la tarea abierta
-- (syncRejectedTask).
create function private.bank_sync_rejected_task(p_company uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_open uuid;
begin
  select t.id into v_open from public.tasks t
   where t.company_id = p_company and t.task_type = 'RESOLVER_RECHAZO_BANCO' and t.status in ('PENDIENTE', 'EN_CURSO')
   order by t.created_at limit 1;
  if not exists (select 1 from public.bank_movements m where m.company_id = p_company and m.status = 'RECHAZADO') then
    if v_open is not null then
      update public.tasks set status = 'RESUELTA', completed_by = (select auth.uid()), completed_at = now()
       where id = v_open;
    end if;
    return null;
  end if;
  if v_open is not null then
    return v_open;
  end if;
  insert into public.tasks (company_id, task_type, title, description, context, assigned_role, priority)
  values (p_company, 'RESOLVER_RECHAZO_BANCO', 'Resolver las órdenes rechazadas por el Banco Aula',
          'El banco rechazó órdenes por falta de fondos: anulá la operación y volvé a pagar, o reenviá la orden desde la bandeja cuando haya fondos.',
          '{}', 'TESORERIA', 'ALTA')
  returning id into v_open;
  return v_open;
end;
$$;

-- El banco ejecuta una orden: si saca más que el saldo según el banco más el acuerdo de descubierto,
-- la rechaza sin debitarla, cobra la comisión por rechazo (un cargo más que registra Contabilidad) y
-- le avisa a Tesorería; si no, la procesa (executeBankOrder).
create function private.bank_execute_order(p_id uuid, p_on date, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.bank_movements;
  v_account public.bank_accounts;
  v_available numeric;
  v_fee public.bank_movements;
  v_task uuid;
begin
  select * into v_order from public.bank_movements m where m.id = p_id;
  select * into v_account from public.bank_accounts b where b.id = v_order.bank_account_id for update;
  select coalesce(sum(case when m.direction = 'CREDITO' then m.amount else -m.amount end), 0) + v_account.overdraft_limit
    into v_available
    from public.bank_movements m where m.bank_account_id = v_account.id and m.status = 'PROCESADO';
  if v_order.direction = 'CREDITO' or v_order.amount <= v_available then
    perform private.bank_process_movement(p_id, p_on, p_user);
    return;
  end if;
  update public.bank_movements set status = 'RECHAZADO', processed_on = p_on, processed_by = p_user where id = p_id;
  v_fee := private.bank_add_movement(v_account, 'BANCO', 'DEBITO',
    case when v_order.cheque_number is not null then 4000 else 2500 end,
    case when v_order.cheque_number is not null then 'Comisión por rechazo del cheque N.º ' || v_order.cheque_number
         else 'Comisión por rechazo de la orden N.º ' || v_order.seq end,
    null, null, null, p_on, null);
  update public.bank_movements set charge = 'RECHAZO' where id = v_fee.id;
  perform private.bank_process_movement(v_fee.id, p_on, p_user);
  v_task := private.bank_sync_rejected_task(v_order.company_id);
  perform private.bank_sync_charges_task(v_order.company_id);
  perform private.notify_roles(
    v_order.company_id, array['TESORERIA'], 'ORDEN_RECHAZADA', 'El Banco Aula rechazó una orden',
    format('La orden N.º %s (%s, %s) supera el saldo más el acuerdo de descubierto: el banco no la debitó y cobró %s de comisión. Anulá la operación y volvé a pagar, o reenviala cuando haya fondos.',
           v_order.seq, v_order.concept, private.format_money(v_order.amount), private.format_money(v_fee.amount)),
    '/e/' || (select c.slug from public.companies c where c.id = v_order.company_id) || '/pagos/banco-aula/bandeja',
    null, v_task
  );
end;
$$;

-- Lo que llega al banco: si lo opera el sistema, ejecuta en el orden de llegada todo lo pendiente que
-- ya se puede cobrar (un cheque, desde que se presenta); si no, espera en la bandeja (settleBankOrders).
-- Reemplaza a la versión que recibía las órdenes recién llegadas.
create function private.bank_settle(p_company uuid)
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
    for v_id in
      select m.id from public.bank_movements m
       where m.company_id = p_company and m.status = 'PENDIENTE'
         and (m.presented_on is null or m.presented_on <= v_today)
       order by m.seq
    loop
      perform private.bank_execute_order(v_id, v_today, null);
    end loop;
  end if;
  perform private.bank_sync_task(p_company);
end;
$$;

-- ------------------------------------------------------------------ Comandos

-- Tesorería reenvía al banco una orden rechazada, cuando hay fondos: vuelve a la bandeja como
-- pendiente, enviada por quien la reenvía (la procesa otro: SoD-12); un cheque se presenta otra vez
-- en el momento. Si lo opera el sistema, el banco la ejecuta enseguida (cmdResendBankOrder).
create function public.bank_order_resend(p_company_id uuid, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'bank.operate');
  v_order public.bank_movements;
  v_today date := private.business_date(p_company_id);
  v_account public.bank_accounts;
begin
  select * into v_order from public.bank_movements m
   where m.id = p_id and m.company_id = p_company_id and m.origin = 'ORDEN';
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'La orden no es de esta empresa.');
  end if;
  if v_order.status <> 'RECHAZADO' then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('La orden N.º %s no está rechazada: está %s.', v_order.seq,
             case v_order.status when 'PENDIENTE' then 'pendiente' when 'PROCESADO' then 'procesada' else 'anulada' end));
  end if;
  update public.bank_movements
     set status = 'PENDIENTE', received_on = v_today, processed_on = null, processed_by = null,
         ordered_by = (select auth.uid()), presented_on = case when presented_on is not null then v_today end
   where id = v_order.id;
  select * into v_account from public.bank_accounts b where b.id = v_order.bank_account_id;
  perform private.log_audit(p_company_id, v_actor, 'RESEND', 'bank_account', v_account.id,
    'Banco Aula ' || v_account.number,
    format('Reenvió al Banco Aula la orden N.º %s (débito de %s), rechazada por falta de fondos', v_order.seq,
           private.format_money(v_order.amount)));
  perform private.bank_settle(p_company_id);
  perform private.bank_sync_rejected_task(p_company_id);
  return jsonb_build_object('status', (select m.status from public.bank_movements m where m.id = v_order.id));
end;
$$;

grant execute on function public.bank_order_resend(uuid, uuid) to authenticated;

-- ------------------------------------------------------------------ Versiones nuevas

-- Igual que antes, salvo que si lo opera el sistema Tesorería no tiene la tarea: un cheque que espera
-- su fecha no se la abre (syncBankTask).
create or replace function private.bank_sync_task(p_company uuid)
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
  if private.bank_mode(p_company) = 'AUTOMATICO'
     or not exists (select 1 from public.bank_movements m where m.company_id = p_company and m.status = 'PENDIENTE') then
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

-- Igual que antes, y además el cheque llega con su número y la fecha en que se presenta al cobro
-- (sendBankOrders).
create or replace function private.bank_send_orders(p_source public.documents, p_entry public.documents)
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
  v_cheque text;
begin
  select regexp_replace(je.description, '\.$', '') into v_concept
    from public.journal_entries je where je.document_id = p_entry.id;
  -- El pago de una orden de pago con cheque: el proveedor lo presenta al cobro unos días después.
  select po.payment_reference into v_cheque from public.payment_orders po
   where po.document_id = p_source.id and p_source.doc_type = 'PAYMENT_ORDER' and po.payment_method = 'CHEQUE';
  for v_line in select l.* from public.journal_entry_lines l where l.document_id = p_entry.id order by l.line_no loop
    select * into v_account from public.bank_accounts b where b.ledger_account_id = v_line.account_id and b.is_active;
    continue when not found;
    v_row := private.bank_add_movement(v_account, 'ORDEN',
      case when v_line.debit > 0 then 'CREDITO' else 'DEBITO' end,
      case when v_line.debit > 0 then v_line.debit else v_line.credit end,
      v_concept, p_source.id, v_line.id, null, v_today, (select auth.uid()));
    if v_cheque is not null and v_line.credit > 0 then
      update public.bank_movements set cheque_number = v_cheque, presented_on = v_today + 3 where id = v_row.id;
    end if;
    v_ids := v_ids || v_row.id;
  end loop;
  if cardinality(v_ids) > 0 then
    perform private.bank_settle(p_entry.company_id);
  end if;
end;
$$;

-- Igual que antes, y además la orden rechazada también se retira (reverseBankOrders).
create or replace function private.bank_reverse_orders(p_reversal public.documents)
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
  v_rejected boolean := false;
  v_unlinked int;
  v_today date := private.business_date(p_reversal.company_id);
begin
  select je.reverses_id into v_original from public.journal_entries je where je.document_id = p_reversal.id;
  if v_original is null then
    return;
  end if;
  -- Al anular el asiento que registró cargos del banco, vuelven a quedar sin registrar (8b.1).
  update public.bank_movements m set journal_line_id = null
    from public.journal_entry_lines l
   where l.id = m.journal_line_id and l.document_id = v_original and m.origin = 'BANCO';
  get diagnostics v_unlinked = row_count;
  if v_unlinked > 0 then
    perform private.bank_sync_charges_task(p_reversal.company_id);
  end if;
  for v_order in
    select m.* from public.bank_movements m join public.journal_entry_lines l on l.id = m.journal_line_id
     where l.document_id = v_original and m.origin = 'ORDEN' and m.reverses_id is null
     order by m.seq
  loop
    if v_order.status in ('PENDIENTE', 'RECHAZADO') then
      if v_order.status = 'RECHAZADO' then
        v_rejected := true;
      end if;
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
    perform private.bank_settle(p_reversal.company_id);
  elsif v_withdrawn then
    perform private.bank_sync_task(p_reversal.company_id);
  end if;
  if v_rejected then
    perform private.bank_sync_rejected_task(p_reversal.company_id);
  end if;
end;
$$;

-- Igual que antes, salvo que cada orden se ejecuta con el saldo que dejó la anterior: la que no tiene
-- fondos se rechaza (cmdProcessBankOrders).
create or replace function public.bank_orders_process(p_company_id uuid, p_ids uuid[])
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
  v_processed int;
  v_refused text;
  v_rejected int;
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
               case v_order.status when 'PROCESADO' then 'procesada' when 'RECHAZADO' then 'rechazada' else 'anulada' end));
    end if;
    if v_sod and v_order.ordered_by = (select auth.uid()) then
      perform private.raise_business_error('SEPARACION_FUNCIONES',
        format('No podés procesar la orden N.º %s: la enviaste vos.', v_order.seq),
        'Separación de funciones (SoD-12): quien envía una orden al banco no la procesa. Tiene que procesarla otro integrante de Tesorería.');
    end if;
  end loop;
  for v_order in select m.* from public.bank_movements m where m.id = any (p_ids) order by m.seq loop
    perform private.bank_execute_order(v_order.id, v_today, (select auth.uid()));
    v_ids := v_ids || v_order.id;
  end loop;
  perform private.bank_sync_task(p_company_id);
  select string_agg(format('%s (%s de %s)', m.transaction_number,
                           case m.direction when 'CREDITO' then 'crédito' else 'débito' end,
                           private.format_money(m.amount)), ', ' order by m.seq), count(*)
    into v_summary, v_processed
    from public.bank_movements m where m.id = any (v_ids) and m.status = 'PROCESADO';
  select string_agg(format('la orden N.º %s (débito de %s)', m.seq, private.format_money(m.amount)), ', ' order by m.seq),
         count(*)
    into v_refused, v_rejected
    from public.bank_movements m where m.id = any (v_ids) and m.status = 'RECHAZADO';
  select b.* into v_account from public.bank_accounts b
    join public.bank_movements m on m.bank_account_id = b.id
   where m.id = v_ids[1];
  perform private.log_audit(p_company_id, v_actor, 'PROCESS', 'bank_account', v_account.id,
    'Banco Aula ' || v_account.number,
    concat_ws('. ',
      case when v_processed > 0 then format('Procesó %s del Banco Aula: %s',
        case when v_processed = 1 then 'la orden' else v_processed || ' órdenes' end, v_summary) end,
      case when v_rejected > 0 then 'Rechazó por falta de fondos ' || v_refused end));
  return jsonb_build_object('processed', v_processed, 'rejected', v_rejected);
end;
$$;

-- Igual que antes, salvo que el banco se mueve sólo al cambiar quién lo opera (antes, con cualquier
-- cambio del control interno y aunque no lo operara el sistema) (cmdUpdateCompanySettings).
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
  -- Al cambiar quién opera el banco: si pasa al sistema, ejecuta lo pendiente con la fecha del día (un
  -- cheque, desde que se presenta); al volver a Tesorería, lo que espera le abre su tarea.
  if p_settings ? 'bank_mode' then
    perform private.bank_settle(p_company_id);
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

-- Igual que antes, y además si lo opera el sistema primero cobra los cheques presentados
-- (cmdCloseBankMonth).
create or replace function public.bank_month_close(p_company_id uuid, p_period text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'bank.operate');
  v_account public.bank_accounts;
  v_today date := private.business_date(p_company_id);
  v_label text;
  v_due text;
  v_fee numeric;
  v_tax numeric;
  v_interest numeric;
  v_charge record;
  v_row public.bank_movements;
  v_rate text;
begin
  select * into v_account from public.bank_accounts b where b.company_id = p_company_id and b.is_active
   order by b.created_at limit 1;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'La empresa no tiene cuenta en el Banco Aula.');
  end if;
  if coalesce(p_period, '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá el mes que se cierra.');
  end if;
  v_label := private.bank_period_label(p_period);
  if exists (select 1 from public.bank_closings c where c.bank_account_id = v_account.id and c.period = p_period) then
    perform private.raise_business_error('TRANSICION_INVALIDA', format('%s ya está cerrado en el Banco Aula.', v_label));
  end if;
  if p_period >= to_char(v_today, 'YYYY-MM') then
    perform private.raise_business_error('DATO_INVALIDO', format('%s todavía no terminó.', v_label));
  end if;
  if p_period < to_char(v_account.charges_from, 'YYYY-MM') then
    perform private.raise_business_error('DATO_INVALIDO',
      format('La cuenta opera en el Banco Aula desde %s: %s no se cierra.',
             private.bank_period_label(to_char(v_account.charges_from, 'YYYY-MM')), v_label));
  end if;
  v_due := private.bank_month_to_close(v_account, v_today);
  if v_due is distinct from p_period then
    perform private.raise_business_error('DATO_INVALIDO', format('Primero hay que cerrar %s.', private.bank_period_label(v_due)));
  end if;
  -- Si lo opera el sistema, antes cobra los cheques que ya se presentaron (8b.2).
  perform private.bank_settle(p_company_id);
  select c.fee, c.tax, c.interest into v_fee, v_tax, v_interest from private.bank_month_charges(v_account, p_period) c;
  -- La tasa como la escribe la interfaz: sin ceros de más ("6", "6.5").
  v_rate := trim(trailing '.' from trim(trailing '0' from v_account.overdraft_rate::text));
  for v_charge in
    select * from (values
      (1, 'COMISION', v_fee, 'Comisión de mantenimiento de cuenta · ' || v_label),
      (2, 'IMPUESTO_DC', v_tax, 'Impuesto a los débitos y créditos (0,6 %) · ' || v_label),
      (3, 'INTERESES', v_interest, 'Intereses por descubierto (' || v_rate || ' % mensual) · ' || v_label)
    ) as c (n, kind, amount, concept)
    order by c.n
  loop
    continue when v_charge.amount <= 0;
    v_row := private.bank_add_movement(v_account, 'BANCO', 'DEBITO', v_charge.amount, v_charge.concept, null, null, null,
                                       v_today, null);
    update public.bank_movements set charge = v_charge.kind where id = v_row.id;
    perform private.bank_process_movement(v_row.id, v_today, (select auth.uid()));
  end loop;
  insert into public.bank_closings (company_id, bank_account_id, period, closed_on, closed_by, fee, tax, interest)
  values (p_company_id, v_account.id, p_period, v_today, (select auth.uid()), v_fee, v_tax, v_interest);
  perform private.log_audit(p_company_id, v_actor, 'CLOSE_MONTH', 'bank_account', v_account.id,
    'Banco Aula ' || v_account.number,
    format('Cerró %s en el Banco Aula: comisión %s, impuesto a los débitos y créditos %s, intereses %s', v_label,
           private.format_money(v_fee), private.format_money(v_tax), private.format_money(v_interest)));
  perform private.bank_sync_charges_task(p_company_id);
  return jsonb_build_object('period', p_period, 'fee', v_fee, 'tax', v_tax, 'interest', v_interest);
end;
$$;

-- Igual que antes, y además el cheque y si todavía no se presentó (BankMovementRow).
create or replace function private.bank_movement_row(p_company uuid, p_m public.bank_movements, p_balance numeric)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_m.id, 'seq', p_m.seq, 'origin', p_m.origin, 'charge', p_m.charge, 'direction', p_m.direction,
    'cheque_number', p_m.cheque_number, 'presented_on', p_m.presented_on,
    'unpresented', coalesce(p_m.presented_on > private.business_date(p_company), false),
    'amount', p_m.amount,
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

-- Igual que antes, y además las órdenes rechazadas (bankAccountView).
create or replace function public.bank_account_view(p_company_id uuid)
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
      'monthly_fee', v_account.monthly_fee, 'overdraft_rate', v_account.overdraft_rate,
      'ledger', jsonb_build_object('id', v_ledger.id, 'code', v_ledger.code, 'name', v_ledger.name)),
    'mode', private.bank_mode(p_company_id),
    'to_close', private.bank_month_to_close(v_account, private.business_date(p_company_id)),
    'balance', v_balance,
    'book_balance', private.account_balance(v_ledger.id),
    'pending', coalesce((
      select jsonb_agg(private.bank_movement_row(p_company_id, m, null) order by m.seq)
        from public.bank_movements m where m.bank_account_id = v_account.id and m.status = 'PENDIENTE'), '[]'),
    'rejected', coalesce((
      select jsonb_agg(private.bank_movement_row(p_company_id, m, null) order by m.seq)
        from public.bank_movements m where m.bank_account_id = v_account.id and m.status = 'RECHAZADO'), '[]'),
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

-- Igual que antes, y además la tarea de las órdenes rechazadas lleva a la bandeja (listTasks).
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
                        when t.task_type = 'PROCESAR_BANCO' then '/e/' || c.slug || '/pagos/banco-aula/bandeja'
                        when t.task_type = 'REGISTRAR_CARGOS_BANCO' then '/e/' || c.slug || '/pagos/conciliaciones/nueva'
                        when t.task_type = 'RESOLVER_RECHAZO_BANCO' then '/e/' || c.slug || '/pagos/banco-aula/bandeja' end,
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

-- La versión anterior de bank_settle, que recibía las órdenes recién llegadas, ya no la usa nadie.
drop function private.bank_settle(uuid, uuid[]);
