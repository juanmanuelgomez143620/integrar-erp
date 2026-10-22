-- 38. La regla base del asiento de cobro (Fase 4c) para las empresas que ya
-- existían (como el paso v9 → v10 del simulador, src/lib/mock/db.ts). Las
-- empresas nuevas la reciben con su contabilidad o la copian de la plantilla.
do $$
declare
  v_company uuid;
begin
  for v_company in select c.id from public.companies c order by c.created_at loop
    perform private.insert_base_posting_rules(v_company);
  end loop;
end;
$$;
