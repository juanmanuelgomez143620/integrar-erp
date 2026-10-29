-- 70. Las empresas creadas antes de la Fase 7b reciben las reglas de los asientos de ingresos
-- brutos (la percepción en la compra, la retención en el cobro, la declaración y su pago)
-- (UPGRADES[18] de src/lib/mock/db.ts). Las facturas de proveedores y los cobros de antes quedan
-- sin percepción ni retención, y las declaraciones de IVA sin base ni alícuota (los valores por
-- defecto de las columnas nuevas). Idempotente.

do $$
declare
  v_company uuid;
begin
  for v_company in select c.id from public.companies c order by c.created_at, c.id loop
    perform private.insert_base_posting_rules(v_company);
  end loop;
end;
$$;
