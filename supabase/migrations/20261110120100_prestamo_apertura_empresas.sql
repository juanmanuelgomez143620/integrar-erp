-- 93. Fase 8c.2 (docs/FASE_8_BANCO_Y_FISCO.md §3): las empresas que ya existían (la plantilla y las
-- de los cursos) reciben el préstamo de la apertura, con las cuotas desde el mes siguiente a que su
-- cuenta empezó a operar en el Banco Aula (UPGRADES[26] de src/lib/mock/db.ts). Idempotente.

do $$
declare
  v_company uuid;
begin
  for v_company in select c.id from public.companies c order by c.created_at, c.id loop
    perform private.bank_open_loan(v_company);
  end loop;
end;
$$;
