-- 100. Fase 8d.2 (docs/FASE_8_BANCO_Y_FISCO.md §4): las empresas que ya existían (la plantilla y las
-- de los cursos) reciben su punto de venta 00001 habilitado, y sus facturas de venta ya registradas,
-- el código de autorización simulado con su fecha, por orden de registro (UPGRADES[28] de
-- src/lib/mock/db.ts). Idempotente.

do $$
declare
  v_company uuid;
begin
  for v_company in select c.id from public.companies c order by c.created_at, c.id loop
    perform private.open_point_of_sale(v_company);
  end loop;
end;
$$;

with numbered as (
  select x.document_id, d.document_date,
         coalesce((select max(right(y.authorization_code, 6)::int) from public.sales_invoices y
                    where y.company_id = x.company_id and y.authorization_code is not null), 0)
         + row_number() over (partition by x.company_id order by x.registered_at, d.display_number collate "C") as n
    from public.sales_invoices x
    join public.documents d on d.id = x.document_id
   where x.invoice_number <> '' and x.authorization_code is null
)
update public.sales_invoices x
   set authorization_code = 'SIM-' || to_char(n.document_date, 'YYYYMMDD') || lpad(n.n::text, 6, '0'),
       authorization_due = n.document_date + 10
  from numbered n
 where n.document_id = x.document_id;
