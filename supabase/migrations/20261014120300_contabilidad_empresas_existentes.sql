-- 17. Contabilidad para las empresas que ya existían antes de la Fase 2 (la
-- plantilla instalada y las de los cursos): plan de cuentas básico, ejercicio
-- del año en curso y asiento de apertura, como el paso v2 → v3 del simulador
-- (src/lib/mock/db.ts). Las empresas nuevas ya nacen con su contabilidad.
do $$
declare
  v_company uuid;
begin
  for v_company in
    select c.id from public.companies c
     where not exists (select 1 from public.documents d where d.company_id = c.id and d.doc_type = 'JOURNAL_ENTRY')
     order by c.created_at
  loop
    perform private.start_accounting(v_company);
  end loop;
end;
$$;
