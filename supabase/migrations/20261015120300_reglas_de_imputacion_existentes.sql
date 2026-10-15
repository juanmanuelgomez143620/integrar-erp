-- 19. Reglas base de la imputación automática para las empresas que ya
-- existían (como el paso v3 → v4 del simulador, src/lib/mock/db.ts). Las
-- empresas nuevas las reciben con su contabilidad o las copian de la plantilla.
do $$
declare
  v_company uuid;
begin
  for v_company in select c.id from public.companies c order by c.created_at loop
    perform private.insert_base_posting_rules(v_company);
  end loop;
end;
$$;
