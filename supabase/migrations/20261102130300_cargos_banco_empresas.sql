-- 86. Fase 8b.1 (docs/FASE_8_BANCO_Y_FISCO.md §3): las empresas que ya existían (la plantilla y las
-- de los cursos) reciben las reglas del asiento de los cargos del Banco Aula (la comisión, el
-- impuesto a los débitos y créditos, los intereses por descubierto y la comisión por rechazo)
-- (UPGRADES[23] de src/lib/mock/db.ts). La comisión y la tasa de descubierto de sus cuentas y el mes
-- desde el que el banco cobra ya los puso la migración 83. Idempotente.

do $$
declare
  v_company uuid;
begin
  for v_company in select c.id from public.companies c order by c.created_at, c.id loop
    perform private.insert_base_posting_rules(v_company);
  end loop;
end;
$$;
