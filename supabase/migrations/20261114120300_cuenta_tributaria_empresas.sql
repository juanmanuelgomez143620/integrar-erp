-- 106. Fase 8e.2 (docs/FASE_8_BANCO_Y_FISCO.md §4): las empresas que ya existían (la plantilla y las
-- de los cursos) reciben la cuenta 5.3.01.04 Intereses resarcitorios (si ya tienen plan de cuentas) y
-- las reglas de los intereses del pago de IVA y de ingresos brutos (UPGRADES[30] de
-- src/lib/mock/db.ts). Idempotente.

do $$
declare
  v_company uuid;
begin
  for v_company in select c.id from public.companies c order by c.created_at, c.id loop
    if exists (select 1 from public.accounts a where a.company_id = v_company) then
      perform private.insert_base_chart(v_company);
    end if;
    perform private.insert_base_posting_rules(v_company);
  end loop;
end;
$$;
