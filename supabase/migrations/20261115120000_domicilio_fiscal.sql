-- 107. Fase 8f.1 (docs/FASE_8_BANCO_Y_FISCO.md §4): el domicilio fiscal electrónico y las intimaciones.
-- Quien opera el fisco (Impuestos, fisco.operate, o el docente) intima a la empresa por las obligaciones
-- de IVA y de ingresos brutos que vencieron desde su alta en la app sin declaración aceptada (falta de
-- presentación) o con el saldo sin imputar (falta de pago), y por las declaraciones aceptadas con una
-- diferencia en el control cruzado, con observaciones opcionales y 15 días para cumplir o responder.
-- Impuestos de la empresa responde con un descargo (no quien la emitió: SoD-16); quien opera el fisco
-- lo acepta (no quien lo escribió) o, si el fisco lo opera el sistema, se acepta en el momento. El
-- sistema la da por cumplida sola al aceptar el fisco la declaración del mes o al imputar su pago.
-- Traducción de "Domicilio fiscal electrónico (8f.1)" de engine.ts.
--
-- La acción de auditoría nueva (RESPOND) está en la migración de catálogos siguiente.

-- ------------------------------------------------------------------ Tablas

create table public.fiscal_notices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  number int not null check (number > 0),
  kind text not null check (kind in ('PRESENTACION', 'PAGO', 'DIFERENCIA')),
  tax text not null check (tax in ('IVA', 'IIBB')),
  period text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  tax_return_id uuid references public.documents (id),
  subject text not null,
  body text not null,
  issued_on date not null,
  issued_by uuid,
  response_due date not null,
  status text not null default 'PENDIENTE' check (status in ('PENDIENTE', 'RESPONDIDA', 'CUMPLIDA')),
  response text check (response is null or length(response) between 10 and 1000),
  responded_on date,
  responded_by uuid,
  closed_on date,
  closed_by uuid,
  close_note text check (close_note is null or length(close_note) <= 300),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  unique (company_id, number),
  unique (company_id, id)
);
create index fiscal_notices_obligation_idx on public.fiscal_notices (company_id, tax, period);

create trigger fiscal_notices_audit before insert or update on public.fiscal_notices
  for each row execute function private.set_audit_fields();
create trigger fiscal_notices_same_company before update on public.fiscal_notices
  for each row execute function private.prevent_company_change();
alter table public.fiscal_notices enable row level security;
revoke all on table public.fiscal_notices from anon, authenticated;
grant select on table public.fiscal_notices to authenticated;
create policy fiscal_notices_select on public.fiscal_notices for select to authenticated
  using (company_id in (select private.companies_with_permission('fisco.read')));

-- ------------------------------------------------------------------ Auxiliares

-- La diferencia del control cruzado de una declaración: lo declarado menos lo que controló el fisco
-- (0 sin control) (controlDifference).
create function private.tax_return_control_difference(p_doc uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case when t.control_amount is null then 0
                else round(case when t.tax = 'IVA' then t.tax_amount else coalesce(t.base, 0) end - t.control_amount, 2) end
      from public.tax_returns t where t.document_id = p_doc), 0)
$$;

-- Lo que el fisco puede intimar hoy (fiscalNoticeCandidates): de las obligaciones de IVA y de ingresos
-- brutos que vencieron desde el alta de la empresa, las que no tienen declaración aceptada (no hay,
-- está en borrador o fue observada) o tienen el saldo sin imputar (presentada o con el pago en el
-- banco); y las declaraciones aceptadas con una diferencia en el control cruzado. Sin las que ya tienen
-- una intimación abierta. Por mes, impuesto y tipo.
create function private.fiscal_notice_candidates(p_company uuid)
returns table (kind text, tax text, period text, due_date date, doc_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with params as (
    select private.business_date(p_company) as today,
           (c.created_at at time zone coalesce((select s.timezone from public.school_settings s where s.id = 1),
                                               'America/Argentina/Buenos_Aires'))::date as since
      from public.companies c where c.id = p_company
  ),
  obligations as (
    select to_char(m, 'YYYY-MM') as period, x.tax,
           private.next_month_day(to_char(m, 'YYYY-MM'), case when x.tax = 'IVA' then 20 else 15 end) as due_date
      from params,
           generate_series(date_trunc('month', params.since::timestamp) - interval '1 month',
                           date_trunc('month', params.today::timestamp) - interval '1 month', interval '1 month') as m,
           (values ('IIBB'), ('IVA')) as x (tax)
  ),
  found as (
    select case when d.id is null or d.status in ('BORRADOR', 'OBSERVADA') then 'PRESENTACION' else 'PAGO' end as kind,
           o.tax, o.period, o.due_date, d.id as doc_id
      from obligations o
      cross join params
      left join lateral (
        select x.id, x.status from public.documents x join public.tax_returns t on t.document_id = x.id
         where x.company_id = p_company and x.doc_type = 'TAX_RETURN' and x.status <> 'ANULADA'
           and t.tax = o.tax and t.period = o.period
         order by x.number
         limit 1) d on true
     where o.due_date >= params.since and o.due_date < params.today
       and (d.id is null or d.status in ('BORRADOR', 'OBSERVADA', 'PRESENTADA', 'PAGO_EN_BANCO'))
    union all
    select 'DIFERENCIA', t.tax, t.period, t.due_date, d.id
      from public.documents d join public.tax_returns t on t.document_id = d.id
     where d.company_id = p_company and d.doc_type = 'TAX_RETURN'
       and d.status in ('PRESENTADA', 'SIN_SALDO', 'PAGO_EN_BANCO', 'PAGADA')
       and private.tax_return_control_difference(d.id) <> 0
  )
  select f.kind, f.tax, f.period, f.due_date, f.doc_id
    from found f
   where not exists (
     select 1 from public.fiscal_notices n
      where n.company_id = p_company and n.kind = f.kind and n.tax = f.tax and n.period = f.period
        and n.status <> 'CUMPLIDA')
   order by f.period, f.tax, array_position(array['PRESENTACION', 'PAGO', 'DIFERENCIA'], f.kind)
$$;

-- El texto del fisco: qué no registra, desde cuándo y el plazo para cumplir; con sus observaciones
-- (fiscalNoticeBody).
create function private.fiscal_notice_body(p_company uuid, p_kind text, p_tax text, p_period text, p_due date,
                                           p_doc uuid, p_today date, p_note text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_name text := (select c.legal_name from public.companies c where c.id = p_company);
  v_what text := private.tax_name(p_tax) || ' de ' || private.period_label(p_period);
  v_doc public.documents;
  v_t public.tax_returns;
  v_text text;
begin
  select * into v_doc from public.documents d where d.id = p_doc;
  select * into v_t from public.tax_returns t where t.document_id = p_doc;
  v_text := case p_kind
    when 'PRESENTACION' then
      format('Al %s, el fisco no registra la presentación de la declaración de %s, que vencía el %s. Se intima a %s a presentarla dentro de los 15 días.',
             to_char(p_today, 'DD/MM/YYYY'), v_what, to_char(p_due, 'DD/MM/YYYY'), v_name)
    when 'PAGO' then
      format('Al %s, el fisco no registra el pago de %s (%s), que vencía el %s: el saldo es %s y los intereses resarcitorios a hoy, %s, que siguen corriendo hasta el pago. Se intima a %s a pagarla dentro de los 15 días.',
             to_char(p_today, 'DD/MM/YYYY'), v_doc.display_number, v_what, to_char(p_due, 'DD/MM/YYYY'),
             private.format_money(v_doc.total), private.format_money(private.tax_interest(v_doc.total, p_due, p_today)),
             v_name)
    else
      format('En %s (%s) se declaró %s de %s y los comprobantes autorizados del mes dan %s. Se intima a %s a explicar la diferencia o a rectificar la declaración dentro de los 15 días.',
             v_doc.display_number, v_what, case when p_tax = 'IVA' then 'un débito fiscal' else 'una base' end,
             private.format_money(case when v_t.tax = 'IVA' then v_t.tax_amount else coalesce(v_t.base, 0) end),
             private.format_money(coalesce(v_t.control_amount, 0)), v_name)
  end;
  return case when p_note <> '' then v_text || ' Observaciones del fisco: ' || p_note else v_text end;
end;
$$;

-- La intimación queda cumplida (closeFiscalNotice): la cierra quien opera el fisco (el actor con su
-- usuario) o el sistema.
create function private.fiscal_notice_close_doc(p_notice uuid, p_actor private.actor, p_note text, p_summary text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n public.fiscal_notices;
begin
  update public.fiscal_notices
     set status = 'CUMPLIDA', closed_on = private.business_date(company_id), closed_by = p_actor.user_id,
         close_note = nullif(p_note, '')
   where id = p_notice
  returning * into v_n;
  perform private.log_audit(v_n.company_id, p_actor, case when p_actor.user_id is null then 'SYSTEM' else 'APPROVE' end,
    'fiscal_notice', v_n.id, 'Intimación N.º ' || v_n.number, p_summary);
end;
$$;

-- Las tareas del domicilio fiscal electrónico (syncFiscalNoticeTasks): mientras haya intimaciones
-- pendientes, Impuestos tiene la de responderlas; mientras haya descargos sin evaluar y el fisco lo
-- opere Impuestos, la de evaluarlos.
create function private.fiscal_notice_sync_tasks(p_company uuid)
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
   where t.company_id = p_company and t.task_type = 'RESPONDER_INTIMACION' and t.status in ('PENDIENTE', 'EN_CURSO')
   order by t.created_at limit 1;
  if exists (select 1 from public.fiscal_notices n where n.company_id = p_company and n.status = 'PENDIENTE') then
    if v_open is null then
      insert into public.tasks (company_id, task_type, title, description, context, assigned_role, priority)
      values (p_company, 'RESPONDER_INTIMACION', 'Responder las intimaciones del fisco',
              'El fisco intimó a la empresa: hay que cumplir lo que pide (presentar o pagar la declaración) o responder con un descargo, desde Fisco simulado → Domicilio fiscal electrónico, dentro del plazo.',
              '{}', 'IMPUESTOS', 'ALTA');
    end if;
  elsif v_open is not null then
    update public.tasks set status = 'RESUELTA', completed_by = (select auth.uid()), completed_at = now()
     where id = v_open;
  end if;
  v_open := null;
  select t.id into v_open from public.tasks t
   where t.company_id = p_company and t.task_type = 'EVALUAR_DESCARGO' and t.status in ('PENDIENTE', 'EN_CURSO')
   order by t.created_at limit 1;
  if not private.fisco_automatic(p_company)
     and exists (select 1 from public.fiscal_notices n where n.company_id = p_company and n.status = 'RESPONDIDA') then
    if v_open is null then
      insert into public.tasks (company_id, task_type, title, description, context, assigned_role, priority)
      values (p_company, 'EVALUAR_DESCARGO', 'Evaluar los descargos de las intimaciones',
              'La empresa respondió intimaciones con su descargo: las evalúa como fisco, desde Fisco simulado → Domicilio fiscal electrónico, un integrante de Impuestos que no escribió el descargo.',
              '{}', 'IMPUESTOS', 'NORMAL')
      returning id into v_task;
      perform private.notify_roles(
        p_company, array['IMPUESTOS'], 'NUEVA_TAREA', 'Descargos para evaluar',
        'La empresa respondió una intimación: evaluá el descargo desde Fisco simulado → Domicilio fiscal electrónico (no los que escribiste vos).',
        '/e/' || (select c.slug from public.companies c where c.id = p_company) || '/fisco/domicilio-fiscal', null, v_task
      );
    end if;
  elsif v_open is not null then
    update public.tasks set status = 'RESUELTA', completed_by = (select auth.uid()), completed_at = now()
     where id = v_open;
  end if;
end;
$$;

-- Al cumplirse una obligación, el sistema da por cumplidas sus intimaciones abiertas de los tipos
-- indicados (fulfillFiscalNotices).
create function private.fiscal_notices_fulfill(p_doc uuid, p_kinds text[], p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n record;
  v_company uuid;
begin
  for v_n in
    select n.id, n.number, n.company_id from public.fiscal_notices n
      join public.tax_returns t on t.document_id = p_doc
     where n.company_id = t.company_id and n.tax = t.tax and n.period = t.period and n.status <> 'CUMPLIDA'
       and n.kind = any (p_kinds)
     order by n.number
  loop
    perform private.fiscal_notice_close_doc(v_n.id, row(null, 'Sistema', 'SISTEMA', null, '—')::private.actor, '',
      format('Dio por cumplida la intimación N.º %s: %s', v_n.number, p_reason));
    v_company := v_n.company_id;
  end loop;
  if v_company is not null then
    perform private.fiscal_notice_sync_tasks(v_company);
  end if;
end;
$$;

-- ------------------------------------------------------------------ Comandos

-- Quien opera el fisco (Impuestos o el docente) intima una obligación vencida o una diferencia del
-- control cruzado, con observaciones opcionales (cmdIssueFiscalNotice). Impuestos y Gerencia reciben el
-- aviso, e Impuestos, la tarea de responder.
create function public.fiscal_notice_issue(p_company_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor;
  v_note text := btrim(coalesce(p_input ->> 'note', ''));
  v_c record;
  v_today date;
  v_number int;
  v_id uuid;
  v_subject text;
  v_label text;
  v_due date;
begin
  perform private.require_active_user();
  v_actor := private.require_permission(p_company_id, 'fisco.operate');
  if length(v_note) > 300 then
    perform private.raise_business_error('DATO_INVALIDO', 'Las observaciones del fisco tienen hasta 300 caracteres.');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('fiscal_notice:' || p_company_id, 0));
  select * into v_c from private.fiscal_notice_candidates(p_company_id) c
   where c.kind = p_input ->> 'kind' and c.tax = p_input ->> 'tax' and c.period = p_input ->> 'period';
  if not found then
    perform private.raise_business_error('DATO_INVALIDO',
      'Esa obligación no se puede intimar: no venció, ya se cumplió o ya tiene una intimación abierta.');
  end if;
  v_today := private.business_date(p_company_id);
  select coalesce(max(n.number), 0) + 1 into v_number from public.fiscal_notices n where n.company_id = p_company_id;
  v_subject := case v_c.kind when 'PRESENTACION' then 'Intimación por falta de presentación'
                             when 'PAGO' then 'Intimación de pago'
                             else 'Requerimiento por diferencia en el control cruzado' end;
  v_due := v_today + 15;
  insert into public.fiscal_notices (company_id, number, kind, tax, period, tax_return_id, subject, body, issued_on,
                                     issued_by, response_due)
  values (p_company_id, v_number, v_c.kind, v_c.tax, v_c.period, v_c.doc_id, v_subject,
          private.fiscal_notice_body(p_company_id, v_c.kind, v_c.tax, v_c.period, v_c.due_date, v_c.doc_id, v_today,
                                     v_note),
          v_today, (select auth.uid()), v_due)
  returning id into v_id;
  v_label := private.tax_name(v_c.tax) || ' de ' || private.period_label(v_c.period);
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'fiscal_notice', v_id, 'Intimación N.º ' || v_number,
    format('Intimó a la empresa: %s de %s (intimación N.º %s)',
           case v_c.kind when 'PRESENTACION' then 'falta de presentación' when 'PAGO' then 'falta de pago'
                         else 'diferencia del control cruzado' end, v_label, v_number));
  perform private.notify_roles(p_company_id, array['IMPUESTOS', 'GERENCIA'], 'INTIMACION',
    format('El fisco intimó a la empresa (N.º %s)', v_number),
    format('%s: %s. Hay que cumplir o responder hasta el %s.', v_subject, v_label, to_char(v_due, 'DD/MM/YYYY')),
    '/e/' || (select c.slug from public.companies c where c.id = p_company_id) || '/fisco/domicilio-fiscal');
  perform private.fiscal_notice_sync_tasks(p_company_id);
  return jsonb_build_object('id', v_id, 'number', v_number);
end;
$$;

grant execute on function public.fiscal_notice_issue(uuid, jsonb) to authenticated;

-- Impuestos responde una intimación pendiente con su descargo (cmdRespondFiscalNotice). SoD-16: no la
-- responde quien la emitió desde el fisco. Si el fisco lo opera el sistema, acepta el descargo en el
-- momento.
create function public.fiscal_notice_respond(p_company_id uuid, p_id uuid, p_response text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor;
  v_n public.fiscal_notices;
  v_text text := btrim(coalesce(p_response, ''));
begin
  perform private.require_active_user();
  v_actor := private.require_permission(p_company_id, 'tax_return.create');
  select * into v_n from public.fiscal_notices n where n.id = p_id and n.company_id = p_company_id for update;
  if v_n.id is null then
    perform private.raise_business_error('DATO_INVALIDO', 'La intimación no es de esta empresa.');
  end if;
  if v_n.status <> 'PENDIENTE' then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('La intimación N.º %s ya está %s.', v_n.number,
             case v_n.status when 'RESPONDIDA' then 'respondida' else 'cumplida' end));
  end if;
  if coalesce((select (c.settings ->> 'sod_enabled')::boolean from public.companies c where c.id = p_company_id), true)
     and not private.is_supervisor(p_company_id)
     and v_n.issued_by = (select auth.uid()) then
    perform private.raise_business_error('SEPARACION_FUNCIONES',
      format('No podés responder la intimación N.º %s: la emitiste vos.', v_n.number),
      'Separación de funciones (SoD-16): quien intima desde el fisco no responde por la empresa. La responde otro integrante de Impuestos.');
  end if;
  if length(v_text) < 10 or length(v_text) > 1000 then
    perform private.raise_business_error('DATO_INVALIDO', 'El descargo tiene de 10 a 1.000 caracteres.');
  end if;
  update public.fiscal_notices
     set status = 'RESPONDIDA', response = v_text, responded_on = private.business_date(p_company_id),
         responded_by = (select auth.uid())
   where id = v_n.id;
  perform private.log_audit(p_company_id, v_actor, 'RESPOND', 'fiscal_notice', v_n.id, 'Intimación N.º ' || v_n.number,
    format('Respondió la intimación N.º %s con su descargo', v_n.number));
  if private.fisco_automatic(p_company_id) then
    perform private.fiscal_notice_close_doc(v_n.id, row(null, 'Sistema', 'SISTEMA', null, '—')::private.actor, '',
      format('El fisco aceptó el descargo y dio por cumplida la intimación N.º %s', v_n.number));
  end if;
  perform private.fiscal_notice_sync_tasks(p_company_id);
end;
$$;

grant execute on function public.fiscal_notice_respond(uuid, uuid, text) to authenticated;

-- Quien opera el fisco acepta el descargo de una intimación respondida y la da por cumplida, con un
-- comentario opcional (cmdCloseFiscalNotice). SoD-16: no evalúa el descargo quien lo escribió.
create function public.fiscal_notice_close(p_company_id uuid, p_id uuid, p_comment text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor;
  v_n public.fiscal_notices;
  v_note text := btrim(coalesce(p_comment, ''));
begin
  perform private.require_active_user();
  v_actor := private.require_permission(p_company_id, 'fisco.operate');
  select * into v_n from public.fiscal_notices n where n.id = p_id and n.company_id = p_company_id for update;
  if v_n.id is null then
    perform private.raise_business_error('DATO_INVALIDO', 'La intimación no es de esta empresa.');
  end if;
  if v_n.status <> 'RESPONDIDA' then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      case when v_n.status = 'PENDIENTE'
        then format('La intimación N.º %s todavía no tiene descargo: se cumple presentando o pagando, o con la respuesta de la empresa.', v_n.number)
        else format('La intimación N.º %s ya está cumplida.', v_n.number) end);
  end if;
  if coalesce((select (c.settings ->> 'sod_enabled')::boolean from public.companies c where c.id = p_company_id), true)
     and not private.is_supervisor(p_company_id)
     and v_n.responded_by = (select auth.uid()) then
    perform private.raise_business_error('SEPARACION_FUNCIONES',
      format('No podés evaluar el descargo de la intimación N.º %s: lo escribiste vos.', v_n.number),
      'Separación de funciones (SoD-16): quien responde por la empresa no evalúa su descargo en el fisco. Lo evalúa otro integrante de Impuestos.');
  end if;
  if length(v_note) > 300 then
    perform private.raise_business_error('DATO_INVALIDO', 'El comentario del fisco tiene hasta 300 caracteres.');
  end if;
  perform private.fiscal_notice_close_doc(v_n.id, v_actor, v_note,
    format('Aceptó el descargo y dio por cumplida la intimación N.º %s%s', v_n.number,
           case when v_note <> '' then ' — ' || v_note else '' end));
  perform private.fiscal_notice_sync_tasks(p_company_id);
end;
$$;

grant execute on function public.fiscal_notice_close(uuid, uuid, text) to authenticated;

-- ------------------------------------------------------------------ Lecturas nuevas

-- El domicilio fiscal electrónico de la empresa (fiscalNotices): las intimaciones, de la más nueva a la
-- más vieja, con su declaración, los nombres y si quien mira puede responderla o evaluar su descargo.
create function public.fiscal_notices(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date;
  v_uid uuid := (select auth.uid());
  v_sod boolean;
  v_respond boolean;
  v_close boolean;
begin
  perform private.require_read(p_company_id, 'fisco.read');
  v_today := private.business_date(p_company_id);
  v_sod := coalesce((select (c.settings ->> 'sod_enabled')::boolean from public.companies c where c.id = p_company_id), true)
     and not private.is_supervisor(p_company_id);
  v_respond := private.has_permission(p_company_id, 'tax_return.create');
  v_close := private.has_permission(p_company_id, 'fisco.operate');
  return coalesce((
    select jsonb_agg(to_jsonb(n) || jsonb_build_object(
             'document', (select jsonb_build_object('id', d.id, 'display_number', d.display_number,
                                                    'path', private.doc_path(d.id))
                            from public.documents d where d.id = n.tax_return_id),
             'issued_by_name', case when n.issued_by is not null then private.full_name(n.issued_by) end,
             'responded_by_name', case when n.responded_by is not null then private.full_name(n.responded_by) end,
             'closed_by_name', case when n.closed_by is not null then private.full_name(n.closed_by) end,
             'overdue', n.status = 'PENDIENTE' and v_today > n.response_due,
             'can_respond', n.status = 'PENDIENTE' and v_respond and not (v_sod and n.issued_by is not distinct from v_uid),
             'can_close', n.status = 'RESPONDIDA' and v_close and not (v_sod and n.responded_by is not distinct from v_uid),
             'sod_reason', case
               when n.status = 'PENDIENTE' and v_respond and v_sod and n.issued_by is not distinct from v_uid
                 then 'Separación de funciones: la emitiste vos desde el fisco; la responde otro integrante de Impuestos.'
               when n.status = 'RESPONDIDA' and v_close and v_sod and n.responded_by is not distinct from v_uid
                 then 'Separación de funciones: escribiste el descargo; lo evalúa otro integrante de Impuestos.' end)
           order by n.number desc)
      from public.fiscal_notices n where n.company_id = p_company_id), '[]'::jsonb);
end;
$$;

grant execute on function public.fiscal_notices(uuid) to authenticated;

-- Lo que el fisco puede intimar hoy (fiscalNoticesToIssue): lo ve quien opera el fisco.
create function public.fiscal_notice_candidates(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'fisco.operate');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'kind', c.kind, 'tax', c.tax, 'period', c.period, 'due_date', c.due_date,
             'document', (select jsonb_build_object('id', d.id, 'display_number', d.display_number,
                                                    'path', private.doc_path(d.id), 'status', d.status)
                            from public.documents d where d.id = c.doc_id),
             'amount', case c.kind when 'PAGO' then (select d.total from public.documents d where d.id = c.doc_id)
                                   when 'DIFERENCIA' then private.tax_return_control_difference(c.doc_id) end)
           order by c.ord)
      from private.fiscal_notice_candidates(p_company_id) with ordinality as c (kind, tax, period, due_date, doc_id, ord)),
    '[]'::jsonb);
end;
$$;

grant execute on function public.fiscal_notice_candidates(uuid) to authenticated;

-- ------------------------------------------------------------------ Versiones nuevas

-- Igual que antes, y al aceptar la declaración, el fisco da por cumplidas las intimaciones de su mes
-- (la falta de presentación; también la de pago si no tiene saldo y la diferencia si coincide)
-- (receiveTaxReturn).
create or replace function private.tax_return_receive_doc(p_doc uuid, p_reason text, p_actor private.actor, p_received_by uuid,
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
  perform private.fiscal_notices_fulfill(v_doc.id,
    array['PRESENTACION']
      || case when v_doc.total > 0 then array[]::text[] else array['PAGO'] end
      || case when private.tax_return_control_difference(v_doc.id) = 0 then array['DIFERENCIA'] else array[]::text[] end,
    format('el fisco aceptó %s', v_doc.display_number));
end;
$$;

-- Igual que antes, y al imputar el pago, el fisco da por cumplida la intimación de pago (imputeTaxPayment).
create or replace function private.tax_return_impute(p_order uuid, p_on date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.bank_movements;
  v_doc public.documents;
begin
  select * into v_order from public.bank_movements m where m.id = p_order;
  if v_order.origin <> 'ORDEN' or v_order.reverses_id is not null or v_order.source_document_id is null then
    return;
  end if;
  select * into v_doc from public.documents d where d.id = v_order.source_document_id;
  if v_doc.id is null or v_doc.doc_type <> 'TAX_RETURN' or v_doc.status <> 'PAGO_EN_BANCO' then
    return;
  end if;
  update public.tax_returns set imputed_on = p_on where document_id = v_doc.id;
  perform private.transition_document(v_doc.id, 'SYSTEM', p_to => 'PAGADA',
    p_actor => row(null, 'Sistema', 'SISTEMA', null, '—')::private.actor,
    p_summary => format('El fisco imputó el pago de %s: %s (transacción %s del Banco Aula)', v_doc.display_number,
                        private.format_money(v_order.amount), v_order.transaction_number));
  perform private.fiscal_notices_fulfill(v_doc.id, array['PAGO'], format('el fisco imputó el pago de %s', v_doc.display_number));
end;
$$;

-- Igual que antes, y si el fisco lo opera el sistema, acepta los descargos que esperaban; las tareas del
-- domicilio fiscal se ponen al día (settleFisco).
create or replace function private.fisco_settle(p_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pos uuid;
  v_dj uuid;
  v_notice record;
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
    for v_notice in
      select n.id, n.number from public.fiscal_notices n
       where n.company_id = p_company and n.status = 'RESPONDIDA' order by n.number
    loop
      perform private.fiscal_notice_close_doc(v_notice.id, row(null, 'Sistema', 'SISTEMA', null, '—')::private.actor, '',
        format('El fisco aceptó el descargo y dio por cumplida la intimación N.º %s', v_notice.number));
    end loop;
  end if;
  perform private.pos_sync_task(p_company);
  perform private.fiscal_notice_sync_tasks(p_company);
end;
$$;

-- Igual que antes, y las tareas del domicilio fiscal electrónico llevan a su pantalla (listTasks).
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
                        when t.task_type in ('RESOLVER_RECHAZO_BANCO', 'EVALUAR_PRESTAMO')
                          then '/e/' || c.slug || '/pagos/banco-aula/bandeja'
                        when t.task_type = 'HABILITAR_PUNTO_VENTA' then '/e/' || c.slug || '/fisco/puntos-de-venta'
                        when t.task_type in ('RESPONDER_INTIMACION', 'EVALUAR_DESCARGO')
                          then '/e/' || c.slug || '/fisco/domicilio-fiscal' end,
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
