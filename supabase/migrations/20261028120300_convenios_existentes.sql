-- 65. Las empresas creadas antes de la Fase 6d reciben los convenios de la demo; cada
-- categoría pasa al suyo (las del taller y la del depósito, a Madera y por hora: lo que
-- cobraban en un mes completo; la de encargado, fuera de convenio; las demás, a Comercio);
-- la categoría y el legajo del chofer si faltan; la cuenta Sindicatos a pagar con sus
-- reglas; y en las liquidaciones que ya había, cada línea queda sin convenio y con los
-- porcentajes de su liquidación (UPGRADES[17] de src/lib/mock/db.ts). Idempotente.
-- Después, toda categoría tiene su convenio: la columna pasa a ser obligatoria.

do $$
declare
  v_company uuid;
begin
  for v_company in select c.id from public.companies c order by c.created_at, c.id loop
    if exists (select 1 from public.accounts a where a.company_id = v_company) then
      perform private.insert_base_chart(v_company);
    end if;
    perform private.insert_base_posting_rules(v_company);
    perform private.insert_demo_labor_agreements(v_company);
    update public.job_categories c
       set agreement_id = a.id,
           basic_salary = case when a.pay_basis = 'HOURLY' then round(c.basic_salary / private.month_hours(), 2)
                               else c.basic_salary end
      from public.labor_agreements a
     where c.company_id = v_company and c.agreement_id is null
       and a.company_id = v_company
       and a.code = case when c.code = 'ENCARGADO' then 'FUERA'
                         when c.is_direct_labor or c.code = 'OPERARIO' then 'MADERA'
                         else 'COMERCIO' end;
    perform private.insert_demo_job_categories(v_company);
    perform private.insert_demo_driver(v_company);
  end loop;
end;
$$;

update public.payroll_lines l
   set seniority_pct = coalesce((p.rates ->> 'seniority_pct')::numeric, 0),
       attendance_pct = coalesce((p.rates ->> 'attendance_pct')::numeric, 0)
  from public.payrolls p
 where p.document_id = l.document_id and l.agreement_id is null;

alter table public.job_categories alter column agreement_id set not null;
