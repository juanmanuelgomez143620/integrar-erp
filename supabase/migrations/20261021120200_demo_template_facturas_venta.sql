-- 16. Empresa plantilla de demostración: FORESTAL DEL NORTE SRL (datos ficticios),
-- ahora con su contabilidad, y los datos del plan de cuentas básico y de la apertura.
-- GENERADO por scripts/generate-demo-sql.mjs desde src/lib/mock/seed.ts y
-- src/lib/domain/chart-of-accounts.ts: no editar a mano.
-- Se ejecuta al instalar una escuela (docs/INSTANCIAS.md): select private.seed_demo_company();
-- Idempotente: si la plantilla ya existe, devuelve su id sin tocarla.

-- ------------------------------------------------------------------ Plan de cuentas básico (a validar por el docente)
create or replace function private.insert_base_chart(p_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.accounts (company_id, code, name, account_type, normal_side, level, is_imputable, description)
  select p_company, a.code, a.name, a.account_type, a.normal_side, a.level, a.is_imputable, a.description
    from (values
      ('1', 'Activo', 'ACTIVO', 'DEBE', 1, false, ''),
      ('1.1', 'Activo corriente', 'ACTIVO', 'DEBE', 2, false, ''),
      ('1.1.01', 'Caja y bancos', 'ACTIVO', 'DEBE', 3, false, ''),
      ('1.1.01.01', 'Caja', 'ACTIVO', 'DEBE', 4, true, 'Dinero en efectivo en poder de la empresa.'),
      ('1.1.01.02', 'Fondo fijo', 'ACTIVO', 'DEBE', 4, true, 'Efectivo asignado para gastos menores, que se repone periódicamente.'),
      ('1.1.01.03', 'Banco cuenta corriente', 'ACTIVO', 'DEBE', 4, true, 'Dinero depositado en la cuenta corriente bancaria de la empresa.'),
      ('1.1.01.04', 'Valores a depositar', 'ACTIVO', 'DEBE', 4, true, 'Cheques de terceros recibidos que todavía no se depositaron.'),
      ('1.1.02', 'Inversiones temporarias', 'ACTIVO', 'DEBE', 3, false, ''),
      ('1.1.02.01', 'Plazo fijo', 'ACTIVO', 'DEBE', 4, true, 'Depósitos a plazo fijo por menos de un año.'),
      ('1.1.03', 'Créditos por ventas', 'ACTIVO', 'DEBE', 3, false, ''),
      ('1.1.03.01', 'Deudores por ventas', 'ACTIVO', 'DEBE', 4, true, 'Lo que los clientes deben por ventas a crédito (cuenta corriente).'),
      ('1.1.03.02', 'Documentos a cobrar', 'ACTIVO', 'DEBE', 4, true, 'Pagarés firmados por clientes a favor de la empresa.'),
      ('1.1.03.03', 'Previsión para deudores incobrables', 'ACTIVO', 'HABER', 4, true, 'Estimación de los créditos que probablemente no se cobren. Regulariza (resta) a Deudores por ventas.'),
      ('1.1.04', 'Otros créditos', 'ACTIVO', 'DEBE', 3, false, ''),
      ('1.1.04.01', 'IVA crédito fiscal', 'ACTIVO', 'DEBE', 4, true, 'IVA facturado por los proveedores en las compras; se descuenta del IVA débito fiscal.'),
      ('1.1.04.02', 'Anticipos a proveedores', 'ACTIVO', 'DEBE', 4, true, 'Pagos adelantados a proveedores por compras que todavía no se recibieron.'),
      ('1.1.04.03', 'Retenciones y percepciones sufridas', 'ACTIVO', 'DEBE', 4, true, 'Impuestos que retuvieron o percibieron terceros y que se descuentan de lo que hay que pagar.'),
      ('1.1.05', 'Bienes de cambio', 'ACTIVO', 'DEBE', 3, false, ''),
      ('1.1.05.01', 'Materias primas', 'ACTIVO', 'DEBE', 4, true, 'Madera, placas y demás materiales que se transforman en la producción.'),
      ('1.1.05.02', 'Materiales e insumos', 'ACTIVO', 'DEBE', 4, true, 'Cola, barniz, herrajes, lijas y embalajes que se consumen en la producción.'),
      ('1.1.05.03', 'Productos en proceso', 'ACTIVO', 'DEBE', 4, true, 'Muebles empezados que todavía no están terminados.'),
      ('1.1.05.04', 'Productos terminados', 'ACTIVO', 'DEBE', 4, true, 'Muebles fabricados listos para la venta.'),
      ('1.1.05.05', 'Mercaderías de reventa', 'ACTIVO', 'DEBE', 4, true, 'Productos comprados para revender sin transformarlos (por ejemplo, colchones).'),
      ('1.2', 'Activo no corriente', 'ACTIVO', 'DEBE', 2, false, ''),
      ('1.2.01', 'Bienes de uso', 'ACTIVO', 'DEBE', 3, false, ''),
      ('1.2.01.01', 'Inmuebles', 'ACTIVO', 'DEBE', 4, true, 'Terreno y edificio de la planta.'),
      ('1.2.01.02', 'Maquinarias y herramientas', 'ACTIVO', 'DEBE', 4, true, 'Sierras, cepilladoras, lijadoras y herramientas de la planta.'),
      ('1.2.01.03', 'Rodados', 'ACTIVO', 'DEBE', 4, true, 'Camiones y vehículos de la empresa.'),
      ('1.2.01.04', 'Muebles y útiles', 'ACTIVO', 'DEBE', 4, true, 'Escritorios, sillas y equipamiento de las oficinas.'),
      ('1.2.01.05', 'Equipos de computación', 'ACTIVO', 'DEBE', 4, true, 'Computadoras, impresoras y equipos de red.'),
      ('1.2.01.06', 'Amortización acumulada de bienes de uso', 'ACTIVO', 'HABER', 4, true, 'Desgaste acumulado de los bienes de uso. Regulariza (resta) a su valor de origen.'),
      ('1.2.02', 'Activos intangibles', 'ACTIVO', 'DEBE', 3, false, ''),
      ('1.2.02.01', 'Software y licencias', 'ACTIVO', 'DEBE', 4, true, 'Programas y licencias de uso adquiridos.'),
      ('2', 'Pasivo', 'PASIVO', 'HABER', 1, false, ''),
      ('2.1', 'Pasivo corriente', 'PASIVO', 'HABER', 2, false, ''),
      ('2.1.01', 'Deudas comerciales', 'PASIVO', 'HABER', 3, false, ''),
      ('2.1.01.01', 'Proveedores', 'PASIVO', 'HABER', 4, true, 'Lo que la empresa debe a sus proveedores por compras a crédito (cuenta corriente).'),
      ('2.1.01.02', 'Documentos a pagar', 'PASIVO', 'HABER', 4, true, 'Pagarés firmados por la empresa a favor de terceros.'),
      ('2.1.01.03', 'Anticipos de clientes', 'PASIVO', 'HABER', 4, true, 'Cobros adelantados por ventas que todavía no se entregaron.'),
      ('2.1.02', 'Deudas bancarias y financieras', 'PASIVO', 'HABER', 3, false, ''),
      ('2.1.02.01', 'Préstamos bancarios', 'PASIVO', 'HABER', 4, true, 'Préstamos de bancos a devolver dentro del año.'),
      ('2.1.03', 'Remuneraciones y cargas sociales', 'PASIVO', 'HABER', 3, false, ''),
      ('2.1.03.01', 'Sueldos a pagar', 'PASIVO', 'HABER', 4, true, 'Sueldos devengados que todavía no se pagaron.'),
      ('2.1.03.02', 'Cargas sociales a pagar', 'PASIVO', 'HABER', 4, true, 'Aportes y contribuciones a la seguridad social pendientes de pago.'),
      ('2.1.04', 'Cargas fiscales', 'PASIVO', 'HABER', 3, false, ''),
      ('2.1.04.01', 'IVA débito fiscal', 'PASIVO', 'HABER', 4, true, 'IVA facturado a los clientes en las ventas.'),
      ('2.1.04.02', 'IVA a pagar', 'PASIVO', 'HABER', 4, true, 'Saldo de IVA a ingresar al fisco al cierre del mes (débito menos crédito).'),
      ('2.1.04.03', 'Ingresos brutos a pagar', 'PASIVO', 'HABER', 4, true, 'Impuesto provincial sobre los ingresos brutos pendiente de pago.'),
      ('2.1.04.04', 'Impuesto a las ganancias a pagar', 'PASIVO', 'HABER', 4, true, 'Impuesto nacional sobre las ganancias pendiente de pago.'),
      ('2.1.05', 'Otras deudas', 'PASIVO', 'HABER', 3, false, ''),
      ('2.1.05.01', 'Acreedores varios', 'PASIVO', 'HABER', 4, true, 'Deudas que no son con proveedores, bancos, el personal ni el fisco.'),
      ('2.2', 'Pasivo no corriente', 'PASIVO', 'HABER', 2, false, ''),
      ('2.2.01', 'Deudas financieras a largo plazo', 'PASIVO', 'HABER', 3, false, ''),
      ('2.2.01.01', 'Préstamos bancarios a largo plazo', 'PASIVO', 'HABER', 4, true, 'Préstamos de bancos a devolver en más de un año.'),
      ('3', 'Patrimonio neto', 'PATRIMONIO_NETO', 'HABER', 1, false, ''),
      ('3.1', 'Aportes de los propietarios', 'PATRIMONIO_NETO', 'HABER', 2, false, ''),
      ('3.1.01', 'Capital', 'PATRIMONIO_NETO', 'HABER', 3, false, ''),
      ('3.1.01.01', 'Capital social', 'PATRIMONIO_NETO', 'HABER', 4, true, 'Aportes de los socios, según el contrato social.'),
      ('3.2', 'Resultados acumulados', 'PATRIMONIO_NETO', 'HABER', 2, false, ''),
      ('3.2.01', 'Reservas', 'PATRIMONIO_NETO', 'HABER', 3, false, ''),
      ('3.2.01.01', 'Reserva legal', 'PATRIMONIO_NETO', 'HABER', 4, true, 'Parte de las ganancias que la ley obliga a retener.'),
      ('3.2.02', 'Resultados', 'PATRIMONIO_NETO', 'HABER', 3, false, ''),
      ('3.2.02.01', 'Resultados no asignados', 'PATRIMONIO_NETO', 'HABER', 4, true, 'Ganancias o pérdidas de ejercicios anteriores que los socios todavía no distribuyeron.'),
      ('3.2.02.02', 'Resultado del ejercicio', 'PATRIMONIO_NETO', 'HABER', 4, true, 'Ganancia o pérdida del ejercicio, al cerrarlo.'),
      ('4', 'Resultados positivos', 'RESULTADO_POSITIVO', 'HABER', 1, false, ''),
      ('4.1', 'Ingresos operativos', 'RESULTADO_POSITIVO', 'HABER', 2, false, ''),
      ('4.1.01', 'Ventas', 'RESULTADO_POSITIVO', 'HABER', 3, false, ''),
      ('4.1.01.01', 'Ventas de productos terminados', 'RESULTADO_POSITIVO', 'HABER', 4, true, 'Ventas de los muebles que fabrica la empresa.'),
      ('4.1.01.02', 'Ventas de mercaderías de reventa', 'RESULTADO_POSITIVO', 'HABER', 4, true, 'Ventas de los productos comprados para revender.'),
      ('4.1.01.03', 'Ingresos por servicios', 'RESULTADO_POSITIVO', 'HABER', 4, true, 'Fletes y otros servicios cobrados a los clientes.'),
      ('4.2', 'Otros resultados positivos', 'RESULTADO_POSITIVO', 'HABER', 2, false, ''),
      ('4.2.01', 'Resultados financieros positivos', 'RESULTADO_POSITIVO', 'HABER', 3, false, ''),
      ('4.2.01.01', 'Intereses ganados', 'RESULTADO_POSITIVO', 'HABER', 4, true, 'Intereses cobrados por plazos fijos o ventas financiadas.'),
      ('4.2.01.02', 'Descuentos obtenidos', 'RESULTADO_POSITIVO', 'HABER', 4, true, 'Descuentos que hacen los proveedores por pagar antes.'),
      ('4.2.02', 'Otros ingresos', 'RESULTADO_POSITIVO', 'HABER', 3, false, ''),
      ('4.2.02.01', 'Sobrante de inventario', 'RESULTADO_POSITIVO', 'HABER', 4, true, 'Diferencia a favor entre el conteo físico y el stock registrado.'),
      ('4.2.02.02', 'Ingresos varios', 'RESULTADO_POSITIVO', 'HABER', 4, true, 'Ingresos ocasionales que no son ventas.'),
      ('5', 'Resultados negativos', 'RESULTADO_NEGATIVO', 'DEBE', 1, false, ''),
      ('5.1', 'Costo de lo vendido', 'RESULTADO_NEGATIVO', 'DEBE', 2, false, ''),
      ('5.1.01', 'Costo de ventas', 'RESULTADO_NEGATIVO', 'DEBE', 3, false, ''),
      ('5.1.01.01', 'Costo de productos vendidos', 'RESULTADO_NEGATIVO', 'DEBE', 4, true, 'Costo de fabricación de los muebles vendidos.'),
      ('5.1.01.02', 'Costo de mercaderías vendidas', 'RESULTADO_NEGATIVO', 'DEBE', 4, true, 'Costo de compra de las mercaderías de reventa vendidas.'),
      ('5.2', 'Gastos de administración y comercialización', 'RESULTADO_NEGATIVO', 'DEBE', 2, false, ''),
      ('5.2.01', 'Gastos en personal', 'RESULTADO_NEGATIVO', 'DEBE', 3, false, ''),
      ('5.2.01.01', 'Sueldos y jornales', 'RESULTADO_NEGATIVO', 'DEBE', 4, true, 'Remuneraciones del personal.'),
      ('5.2.01.02', 'Cargas sociales', 'RESULTADO_NEGATIVO', 'DEBE', 4, true, 'Contribuciones patronales a la seguridad social.'),
      ('5.2.02', 'Gastos generales', 'RESULTADO_NEGATIVO', 'DEBE', 3, false, ''),
      ('5.2.02.01', 'Alquileres', 'RESULTADO_NEGATIVO', 'DEBE', 4, true, 'Alquileres que paga la empresa (por ejemplo, el del showroom).'),
      ('5.2.02.02', 'Servicios públicos', 'RESULTADO_NEGATIVO', 'DEBE', 4, true, 'Energía eléctrica, agua y gas.'),
      ('5.2.02.03', 'Teléfono e internet', 'RESULTADO_NEGATIVO', 'DEBE', 4, true, 'Telefonía e internet.'),
      ('5.2.02.04', 'Fletes y acarreos', 'RESULTADO_NEGATIVO', 'DEBE', 4, true, 'Transporte de compras y ventas a cargo de la empresa.'),
      ('5.2.02.05', 'Gastos de librería y oficina', 'RESULTADO_NEGATIVO', 'DEBE', 4, true, 'Papelería e insumos de oficina.'),
      ('5.2.02.06', 'Seguros', 'RESULTADO_NEGATIVO', 'DEBE', 4, true, 'Primas de seguros de bienes y personas.'),
      ('5.2.02.07', 'Publicidad', 'RESULTADO_NEGATIVO', 'DEBE', 4, true, 'Avisos y promoción.'),
      ('5.2.02.08', 'Mantenimiento y reparaciones', 'RESULTADO_NEGATIVO', 'DEBE', 4, true, 'Arreglos de máquinas, vehículos e instalaciones.'),
      ('5.2.02.09', 'Amortizaciones de bienes de uso', 'RESULTADO_NEGATIVO', 'DEBE', 4, true, 'Desgaste del período de los bienes de uso.'),
      ('5.2.02.10', 'Deudores incobrables', 'RESULTADO_NEGATIVO', 'DEBE', 4, true, 'Créditos que se dan por perdidos.'),
      ('5.2.03', 'Impuestos y tasas', 'RESULTADO_NEGATIVO', 'DEBE', 3, false, ''),
      ('5.2.03.01', 'Impuesto sobre los ingresos brutos', 'RESULTADO_NEGATIVO', 'DEBE', 4, true, 'Impuesto provincial que se calcula sobre las ventas.'),
      ('5.2.03.02', 'Tasas municipales', 'RESULTADO_NEGATIVO', 'DEBE', 4, true, 'Tasa de comercio e higiene y otros tributos municipales.'),
      ('5.3', 'Resultados financieros y otros egresos', 'RESULTADO_NEGATIVO', 'DEBE', 2, false, ''),
      ('5.3.01', 'Gastos financieros', 'RESULTADO_NEGATIVO', 'DEBE', 3, false, ''),
      ('5.3.01.01', 'Intereses perdidos', 'RESULTADO_NEGATIVO', 'DEBE', 4, true, 'Intereses pagados por préstamos o compras financiadas.'),
      ('5.3.01.02', 'Descuentos otorgados', 'RESULTADO_NEGATIVO', 'DEBE', 4, true, 'Descuentos a clientes por pagar antes.'),
      ('5.3.01.03', 'Gastos y comisiones bancarias', 'RESULTADO_NEGATIVO', 'DEBE', 4, true, 'Mantenimiento de cuenta, comisiones e impuestos bancarios.'),
      ('5.3.02', 'Otras pérdidas', 'RESULTADO_NEGATIVO', 'DEBE', 3, false, ''),
      ('5.3.02.01', 'Faltante de inventario', 'RESULTADO_NEGATIVO', 'DEBE', 4, true, 'Diferencia en contra entre el conteo físico y el stock registrado.'),
      ('5.3.02.02', 'Pérdida por roturas', 'RESULTADO_NEGATIVO', 'DEBE', 4, true, 'Bienes que se rompieron o deterioraron y se dan de baja.')
    ) as a (code, name, account_type, normal_side, level, is_imputable, description);
end;
$$;

-- Saldos fijos del asiento de apertura; los bienes de cambio salen del inventario inicial.
create or replace function private.opening_amounts()
returns table (code text, debit numeric, credit numeric)
language sql
immutable
set search_path = ''
as $$
  select o.code::text, o.debit::numeric, o.credit::numeric
    from (values
      ('1.1.01.01', 850000, 0),
      ('1.1.01.03', 12500000, 0),
      ('1.2.01.01', 85000000, 0),
      ('1.2.01.02', 24000000, 0),
      ('1.2.01.03', 18000000, 0),
      ('1.2.01.04', 3200000, 0),
      ('2.1.02.01', 0, 10000000),
      ('3.1.01.01', 0, 120000000)
    ) as o (code, debit, credit)
$$;

-- Cuenta de bienes de cambio de cada tipo de producto.
create or replace function private.inventory_account(p_product_type text)
returns text
language sql
immutable
set search_path = ''
as $$ select case p_product_type when 'MATERIA_PRIMA' then '1.1.05.01' when 'INSUMO' then '1.1.05.02' when 'PRODUCTO_TERMINADO' then '1.1.05.04' when 'MERCADERIA_REVENTA' then '1.1.05.05' end $$;

-- La diferencia del asiento de apertura.
create or replace function private.opening_balancing_account()
returns text
language sql
immutable
set search_path = ''
as $$ select '3.2.02.01'::text $$;

-- Reglas base de la imputación automática, sin pisar las que la empresa ya tiene.
create or replace function private.insert_base_posting_rules(p_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.posting_rules (company_id, event, key, account_id)
  select p_company, r.event, r.key, a.id
    from (values
      ('COMPRA', 'MATERIA_PRIMA', '1.1.05.01'),
      ('COMPRA', 'INSUMO', '1.1.05.02'),
      ('COMPRA', 'PRODUCTO_TERMINADO', '1.1.05.04'),
      ('COMPRA', 'MERCADERIA_REVENTA', '1.1.05.05'),
      ('COMPRA', 'SERVICIO', '5.2.02.04'),
      ('COMPRA', 'IVA_CREDITO', '1.1.04.01'),
      ('COMPRA', 'PROVEEDORES', '2.1.01.01'),
      ('PAGO', 'PROVEEDORES', '2.1.01.01'),
      ('COSTO_VENTA', 'COSTO_PRODUCTO_TERMINADO', '5.1.01.01'),
      ('COSTO_VENTA', 'COSTO_MERCADERIA_REVENTA', '5.1.01.02'),
      ('COSTO_VENTA', 'PRODUCTO_TERMINADO', '1.1.05.04'),
      ('COSTO_VENTA', 'MERCADERIA_REVENTA', '1.1.05.05'),
      ('VENTA', 'PRODUCTO_TERMINADO', '4.1.01.01'),
      ('VENTA', 'MERCADERIA_REVENTA', '4.1.01.02'),
      ('VENTA', 'SERVICIO', '4.1.01.03'),
      ('VENTA', 'IVA_DEBITO', '2.1.04.01'),
      ('VENTA', 'DEUDORES', '1.1.03.01')
    ) as r (event, key, code)
    join public.accounts a on a.company_id = p_company and a.code = r.code
   where not exists (
     select 1 from public.posting_rules x where x.company_id = p_company and x.event = r.event and x.key = r.key
   );
end;
$$;

-- Rubro de las cajas y los bancos: sus cuentas imputables son desde donde se paga.
create or replace function private.treasury_rubro()
returns text
language sql
immutable
set search_path = ''
as $$ select '1.1.01'::text $$;

-- ------------------------------------------------------------------ Empresa plantilla
create or replace function private.seed_demo_company()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select c.id into v_id from public.companies c where c.slug = 'forestal-del-norte';
  if found then
    return v_id;
  end if;

  insert into public.companies (slug, legal_name, trade_name, tax_id, vat_condition, activity, address_line, city, province,
                                start_date, is_template, settings)
  values ('forestal-del-norte', 'Forestal del Norte SRL', 'Forestal del Norte', '30-00000001-5',
          'RESPONSABLE_INSCRIPTO', 'Fabricación de muebles y productos derivados de la madera', 'Av. de los Pioneros 1500 (domicilio ficticio)', 'Eldorado',
          'Misiones', '2015-03-02', true, '{"sod_enabled":true,"allow_negative_stock":false}')
  returning id into v_id;

  insert into public.islands (company_id, number, name)
  select v_id, i.number, i.name from (values
      (1, 'Gerencia y Control de Gestión'),
      (2, 'Compras'),
      (3, 'Ventas y Clientes'),
      (4, 'Contabilidad e Impuestos'),
      (5, 'Tesorería y Finanzas'),
      (6, 'RRHH y Sueldos'),
      (7, 'Producción y Costos'),
      (8, 'Depósito y Logística')
    ) as i (number, name);

  insert into public.sectors (company_id, code, name, island_id)
  select v_id, s.code, s.name, i.id
    from (values
      ('GER', 'Gerencia', 1),
      ('CGE', 'Control de Gestión', 1),
      ('COM', 'Compras', 2),
      ('VEN', 'Ventas', 3),
      ('CON', 'Contabilidad', 4),
      ('IMP', 'Impuestos', 4),
      ('TES', 'Tesorería y Finanzas', 5),
      ('RRH', 'RRHH y Sueldos', 6),
      ('PRO', 'Producción', 7),
      ('COS', 'Costos', 7),
      ('DEP', 'Depósito', 8),
      ('LOG', 'Logística', 8)
    ) as s (code, name, island)
    left join public.islands i on i.company_id = v_id and i.number = s.island;

  insert into public.warehouses (company_id, code, name)
  select v_id, w.code, w.name from (values
      ('DEP-MP', 'Depósito de materias primas e insumos'),
      ('DEP-PT', 'Depósito de productos terminados')
    ) as w (code, name);

  insert into public.company_modules (company_id, module_code, is_enabled)
  select v_id, m.code, m.enabled from (values
      ('masters', true),
      ('purchasing', true),
      ('inventory', true),
      ('accounting', true),
      ('management', true),
      ('audit', true)
    ) as m (code, enabled);

  insert into public.approval_rules (company_id, doc_type, level, min_amount, max_amount, approver_role,
                                     require_different_user, description)
  select v_id, r.doc_type, r.level, r.min_amount, r.max_amount::numeric, r.approver_role, r.require_different_user, r.description
    from (values
      ('PURCHASE_ORDER', 1, 0, 500000, 'COMPRAS', true, 'Órdenes de hasta $ 500.000 (IVA incluido): las aprueba otro integrante de Compras.'),
      ('PURCHASE_ORDER', 1, 500000.01, null, 'GERENCIA', true, 'Órdenes de más de $ 500.000 (IVA incluido): las aprueba Gerencia.')
    ) as r (doc_type, level, min_amount, max_amount, approver_role, require_different_user, description);

  insert into public.suppliers (company_id, code, legal_name, trade_name, tax_id, vat_condition, address_line, city, province,
                                phone, email, contact_name, payment_terms_days, lead_time_days, category, notes)
  select v_id, s.code, s.legal_name, s.trade_name, s.tax_id, s.vat_condition, s.address_line, s.city, s.province,
         s.phone, s.email, s.contact_name, s.payment_terms_days, s.lead_time_days, s.category, s.notes
    from (values
      ('PRV-001', 'Aserradero Monte Verde SRL', '', '30-00000100-3', 'RESPONSABLE_INSCRIPTO', 'Domicilio ficticio', 'Montecarlo', 'Misiones', '', '', 'Rubén Ayala', 30, 5, 'Aserradero', ''),
      ('PRV-002', 'Placas del Litoral SA', '', '30-00000101-1', 'RESPONSABLE_INSCRIPTO', 'Domicilio ficticio', 'Posadas', 'Misiones', '', '', 'Gabriela Núñez', 30, 7, 'Placas y tableros', ''),
      ('PRV-003', 'Herrajes Guaraníes SRL', '', '30-00000102-9', 'RESPONSABLE_INSCRIPTO', 'Domicilio ficticio', 'Oberá', 'Misiones', '', '', 'Esteban Krause', 30, 4, 'Herrajes', ''),
      ('PRV-004', 'Pinturería Tierra Roja', '', '30-00000103-8', 'RESPONSABLE_INSCRIPTO', 'Domicilio ficticio', 'Eldorado', 'Misiones', '', '', 'Mónica Vera', 30, 2, 'Pinturería', ''),
      ('PRV-005', 'Bulonera Central Eldorado', '', '30-00000104-6', 'RESPONSABLE_INSCRIPTO', 'Domicilio ficticio', 'Eldorado', 'Misiones', '', '', 'Hugo Benítez', 30, 2, 'Bulonera', ''),
      ('PRV-006', 'Embalajes Misioneros SA', '', '30-00000105-4', 'RESPONSABLE_INSCRIPTO', 'Domicilio ficticio', 'Posadas', 'Misiones', '', '', 'Cecilia Duarte', 30, 6, 'Embalajes', ''),
      ('PRV-007', 'Colchonera del Nordeste SRL', '', '30-00000106-2', 'RESPONSABLE_INSCRIPTO', 'Domicilio ficticio', 'Resistencia', 'Chaco', '', '', 'Raúl Giménez', 30, 10, 'Colchones', ''),
      ('PRV-008', 'Transportes Ruta 12 SRL', '', '30-00000107-0', 'RESPONSABLE_INSCRIPTO', 'Domicilio ficticio', 'Eldorado', 'Misiones', '', '', 'Omar Ferreyra', 30, 1, 'Transporte', ''),
      ('PRV-009', 'Ferretería Industrial Oberá', '', '30-00000108-9', 'RESPONSABLE_INSCRIPTO', 'Domicilio ficticio', 'Oberá', 'Misiones', '', '', 'Silvina Kowalczuk', 30, 3, 'Ferretería', ''),
      ('PRV-010', 'Servicios Técnicos Iguazú', '', '20-00000109-1', 'MONOTRIBUTO', 'Domicilio ficticio', 'Puerto Iguazú', 'Misiones', '', '', 'Andrés Cabral', 0, 2, 'Servicios', '')
    ) as s (code, legal_name, trade_name, tax_id, vat_condition, address_line, city, province, phone, email,
            contact_name, payment_terms_days, lead_time_days, category, notes);

  insert into public.customers (company_id, code, legal_name, trade_name, tax_id, vat_condition, address_line, city, province,
                                phone, email, contact_name, payment_terms_days, credit_limit, notes)
  select v_id, c.code, c.legal_name, c.trade_name, c.tax_id, c.vat_condition, c.address_line, c.city, c.province,
         c.phone, c.email, c.contact_name, c.payment_terms_days, c.credit_limit::numeric, c.notes
    from (values
      ('CLI-001', 'Mueblería El Ceibo SRL', '', '30-00000200-9', 'RESPONSABLE_INSCRIPTO', 'Domicilio ficticio', 'Posadas', 'Misiones', '', '', '', 30, 4000000, ''),
      ('CLI-002', 'Hogar Colonial SA', '', '30-00000201-8', 'RESPONSABLE_INSCRIPTO', 'Domicilio ficticio', 'Oberá', 'Misiones', '', '', '', 30, 6000000, ''),
      ('CLI-003', 'Distribuidora Paraná Muebles SRL', '', '30-00000202-6', 'RESPONSABLE_INSCRIPTO', 'Domicilio ficticio', 'Corrientes', 'Corrientes', '', '', '', 45, 8000000, ''),
      ('CLI-004', 'Constructora Tierra Colorada SA', '', '30-00000203-4', 'RESPONSABLE_INSCRIPTO', 'Domicilio ficticio', 'Posadas', 'Misiones', '', '', '', 60, 10000000, ''),
      ('CLI-005', 'Carpintería Don Aurelio', '', '20-00000204-7', 'MONOTRIBUTO', 'Domicilio ficticio', 'Apóstoles', 'Misiones', '', '', '', 15, 800000, ''),
      ('CLI-006', 'Cabañas Arroyo Azul', '', '20-00000205-5', 'MONOTRIBUTO', 'Domicilio ficticio', 'Puerto Iguazú', 'Misiones', '', '', '', 15, 1500000, ''),
      ('CLI-007', 'Instituto de Formación Profesional (ficticio)', '', '30-00000206-9', 'EXENTO', 'Domicilio ficticio', 'Eldorado', 'Misiones', '', '', '', 30, 2000000, ''),
      ('CLI-008', 'Decoraciones Yerba Mate SRL', '', '30-00000207-7', 'RESPONSABLE_INSCRIPTO', 'Domicilio ficticio', 'Leandro N. Alem', 'Misiones', '', '', '', 30, 2500000, ''),
      ('CLI-009', 'Consumidor final — Mostrador', '', '', 'CONSUMIDOR_FINAL', 'Domicilio ficticio', 'Eldorado', 'Misiones', '', '', '', 0, null, ''),
      ('CLI-010', 'Amoblamientos del Sur SRL', '', '30-00000209-3', 'RESPONSABLE_INSCRIPTO', 'Domicilio ficticio', 'Posadas', 'Misiones', '', '', '', 30, 3000000, '')
    ) as c (code, legal_name, trade_name, tax_id, vat_condition, address_line, city, province, phone, email,
            contact_name, payment_terms_days, credit_limit, notes);

  insert into public.products (company_id, code, name, description, category, product_type, uom_code, is_stockable,
                               standard_cost, sale_price, vat_rate, min_stock, reorder_qty, default_supplier_id,
                               default_warehouse_id, location)
  select v_id, p.code, p.name, p.description, p.category, p.product_type, p.uom_code, p.is_stockable,
         p.standard_cost, p.sale_price::numeric, p.vat_rate, p.min_stock, p.reorder_qty::numeric, s.id, w.id, p.location
    from (values
      ('MP-001', 'Tabla de pino elliottis 1" × 6"', '', 'Madera maciza', 'MATERIA_PRIMA', 'PIE', true, 1300, null, 21, 800, 1000, 'PRV-001', 'DEP-MP', 'Nave 1'),
      ('MP-002', 'Tabla de eucalipto grandis 1" × 8"', '', 'Madera maciza', 'MATERIA_PRIMA', 'PIE', true, 1600, null, 21, 600, 800, 'PRV-001', 'DEP-MP', 'Nave 1'),
      ('MP-003', 'Tirante de pino 2" × 3"', '', 'Madera maciza', 'MATERIA_PRIMA', 'PIE', true, 1400, null, 21, 400, 500, 'PRV-001', 'DEP-MP', 'Nave 1'),
      ('MP-004', 'Placa MDF 18 mm 1,83 × 2,60 m', '', 'Placas y tableros', 'MATERIA_PRIMA', 'UN', true, 92000, null, 21, 20, 40, 'PRV-002', 'DEP-MP', 'Nave 1'),
      ('MP-005', 'Placa MDF 5,5 mm (fondos)', '', 'Placas y tableros', 'MATERIA_PRIMA', 'UN', true, 38000, null, 21, 15, 30, 'PRV-002', 'DEP-MP', 'Nave 1'),
      ('MP-006', 'Placa fenólica 18 mm', '', 'Placas y tableros', 'MATERIA_PRIMA', 'UN', true, 115000, null, 21, 10, 20, 'PRV-002', 'DEP-MP', 'Nave 1'),
      ('MP-007', 'Tablero de pino finger joint 18 mm', '', 'Placas y tableros', 'MATERIA_PRIMA', 'UN', true, 105000, null, 21, 10, 20, 'PRV-002', 'DEP-MP', 'Nave 1'),
      ('IN-001', 'Cola vinílica para madera', '', 'Adhesivos y terminación', 'INSUMO', 'KG', true, 6500, null, 21, 20, 40, 'PRV-009', 'DEP-MP', 'Nave 1'),
      ('IN-002', 'Barniz poliuretánico', '', 'Adhesivos y terminación', 'INSUMO', 'L', true, 18000, null, 21, 15, 30, 'PRV-004', 'DEP-MP', 'Nave 1'),
      ('IN-003', 'Tornillo para madera 4 × 40 (caja × 500)', '', 'Herrajes y fijaciones', 'INSUMO', 'CAJA', true, 14000, null, 21, 10, 20, 'PRV-005', 'DEP-MP', 'Nave 1'),
      ('IN-004', 'Bisagra cazoleta 35 mm', '', 'Herrajes y fijaciones', 'INSUMO', 'UN', true, 2200, null, 21, 100, 200, 'PRV-003', 'DEP-MP', 'Nave 1'),
      ('IN-005', 'Corredera telescópica 45 cm', '', 'Herrajes y fijaciones', 'INSUMO', 'PAR', true, 9500, null, 21, 40, 100, 'PRV-003', 'DEP-MP', 'Nave 1'),
      ('IN-006', 'Lija grano 120', '', 'Adhesivos y terminación', 'INSUMO', 'UN', true, 900, null, 21, 100, 200, 'PRV-009', 'DEP-MP', 'Nave 1'),
      ('IN-007', 'Film stretch para embalaje', '', 'Embalaje', 'INSUMO', 'ROL', true, 16000, null, 21, 5, 10, 'PRV-006', 'DEP-MP', 'Nave 1'),
      ('PT-001', 'Mesa de comedor de pino 1,60 m', '', 'Comedor', 'PRODUCTO_TERMINADO', 'UN', true, 260000, 520000, 21, 4, null, null, 'DEP-PT', 'Nave 2'),
      ('PT-002', 'Silla de eucalipto', '', 'Comedor', 'PRODUCTO_TERMINADO', 'UN', true, 62000, 125000, 21, 12, null, null, 'DEP-PT', 'Nave 2'),
      ('PT-003', 'Placard de MDF 2 puertas', '', 'Dormitorio', 'PRODUCTO_TERMINADO', 'UN', true, 310000, 640000, 21, 3, null, null, 'DEP-PT', 'Nave 2'),
      ('PT-004', 'Cama 2 plazas de eucalipto', '', 'Dormitorio', 'PRODUCTO_TERMINADO', 'UN', true, 290000, 580000, 21, 3, null, null, 'DEP-PT', 'Nave 2'),
      ('MR-001', 'Colchón 2 plazas (reventa)', '', 'Reventa', 'MERCADERIA_REVENTA', 'UN', true, 240000, 390000, 21, 4, 8, 'PRV-007', 'DEP-PT', 'Nave 2'),
      ('SV-001', 'Servicio de flete y entrega', '', 'Servicios', 'SERVICIO', 'UN', false, 0, 45000, 21, 0, null, 'PRV-008', 'DEP-PT', 'Nave 2')
    ) as p (code, name, description, category, product_type, uom_code, is_stockable, standard_cost, sale_price, vat_rate,
            min_stock, reorder_qty, supplier_code, warehouse_code, location)
    left join public.suppliers s on s.company_id = v_id and s.code = p.supplier_code
    left join public.warehouses w on w.company_id = v_id and w.code = p.warehouse_code;

  -- Inventario inicial documentado (un ajuste por depósito), contabilidad con su
  -- asiento de apertura y alertas de arranque.
  perform private.post_initial_stock(v_id,
    (select w.id from public.warehouses w where w.company_id = v_id and w.code = 'DEP-MP'),
    (select jsonb_agg(jsonb_build_object('product_id', p.id, 'quantity_delta', l.qty, 'unit_cost', l.cost) order by l.ord)
       from (values
      ('MP-001', 1200, 1300, 1),
      ('MP-002', 900, 1600, 2),
      ('MP-003', 520, 1400, 3),
      ('MP-004', 8, 92000, 4),
      ('MP-005', 22, 38000, 5),
      ('MP-006', 12, 115000, 6),
      ('MP-007', 6, 105000, 7),
      ('IN-001', 35, 6500, 8),
      ('IN-002', 18, 18000, 9),
      ('IN-003', 14, 14000, 10),
      ('IN-004', 240, 2200, 11),
      ('IN-005', 36, 9500, 12),
      ('IN-006', 150, 900, 13),
      ('IN-007', 9, 16000, 14)
       ) as l (code, qty, cost, ord)
       join public.products p on p.company_id = v_id and p.code = l.code));
  perform private.post_initial_stock(v_id,
    (select w.id from public.warehouses w where w.company_id = v_id and w.code = 'DEP-PT'),
    (select jsonb_agg(jsonb_build_object('product_id', p.id, 'quantity_delta', l.qty, 'unit_cost', l.cost) order by l.ord)
       from (values
      ('PT-001', 6, 260000, 1),
      ('PT-002', 30, 62000, 2),
      ('PT-003', 4, 310000, 3),
      ('PT-004', 5, 290000, 4),
      ('MR-001', 7, 240000, 5)
       ) as l (code, qty, cost, ord)
       join public.products p on p.company_id = v_id and p.code = l.code));
  perform private.start_accounting(v_id);
  perform private.scan_stock_alerts(v_id);
  return v_id;
end;
$$;
