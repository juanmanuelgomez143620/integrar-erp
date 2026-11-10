-- 91. Fase 8c.1 (docs/FASE_8_BANCO_Y_FISCO.md §3): las empresas que ya existían (la plantilla y las
-- de los cursos) reciben las reglas del asiento de los préstamos del Banco Aula (la acreditación y el
-- capital de las cuotas a Préstamos bancarios; los intereses, a Intereses perdidos) (UPGRADES[25] de
-- src/lib/mock/db.ts). Idempotente.

do $$
declare
  v_company uuid;
begin
  for v_company in select c.id from public.companies c order by c.created_at, c.id loop
    perform private.insert_base_posting_rules(v_company);
  end loop;
end;
$$;
