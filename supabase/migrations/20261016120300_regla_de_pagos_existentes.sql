-- 22. La regla base de imputación de los pagos para las empresas que ya
-- existían (como el paso v4 → v5 del simulador, src/lib/mock/db.ts). Las
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
