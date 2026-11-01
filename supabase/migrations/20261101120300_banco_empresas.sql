-- 81. Fase 8a.1 (docs/FASE_8_BANCO_Y_FISCO.md §3): las empresas que ya existían (la plantilla y las
-- de los cursos) reciben la isla del entorno (banco y fisco) con sus sectores y su cuenta en el Banco
-- Aula: el saldo inicial es el del asiento de apertura y lo que ya movió el banco queda procesado con
-- la fecha de cada asiento, así el saldo según el banco coincide con el de libros. El banco arranca
-- operado por el sistema. Idempotente: una empresa que ya tiene la isla o la cuenta no cambia.

do $$
declare
  v_company uuid;
begin
  for v_company in select c.id from public.companies c order by c.created_at, c.id loop
    perform private.insert_environment(v_company);
    perform private.bank_open_account(v_company);
  end loop;
end;
$$;
