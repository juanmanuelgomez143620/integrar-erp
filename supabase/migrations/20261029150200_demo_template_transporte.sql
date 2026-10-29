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
      ('2.1.03.03', 'Sindicatos a pagar', 'PASIVO', 'HABER', 4, true, 'Aportes sindicales retenidos al personal y contribuciones de los convenios pendientes de depositar.'),
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
      ('5.1.02', 'Costos de producción aplicados', 'RESULTADO_NEGATIVO', 'DEBE', 3, false, ''),
      ('5.1.02.01', 'Mano de obra directa aplicada', 'RESULTADO_NEGATIVO', 'HABER', 4, true, 'Mano de obra que las órdenes de producción cargaron a su costo (horas por tarifa). Regulariza (resta) a los sueldos de la fábrica: la diferencia es la sub- o sobreaplicación.'),
      ('5.1.02.02', 'Carga fabril aplicada', 'RESULTADO_NEGATIVO', 'HABER', 4, true, 'Costos indirectos de fabricación que las órdenes cargaron a su costo (horas por tasa). Regulariza (resta) a los gastos reales de la fábrica.'),
      ('5.1.03', 'Costos de producción reales', 'RESULTADO_NEGATIVO', 'DEBE', 3, false, ''),
      ('5.1.03.01', 'Mano de obra directa', 'RESULTADO_NEGATIVO', 'DEBE', 4, true, 'Sueldos y contribuciones del personal del taller: el costo real de la mano de obra. Contra la aplicada a las órdenes (5.1.02.01) da la sub- o sobreaplicación.'),
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
    ) as a (code, name, account_type, normal_side, level, is_imputable, description)
   where not exists (select 1 from public.accounts x where x.company_id = p_company and x.code = a.code);
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
      ('COMPRA', 'PERCEPCIONES', '1.1.04.03'),
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
      ('VENTA', 'DEUDORES', '1.1.03.01'),
      ('COBRO', 'DEUDORES', '1.1.03.01'),
      ('COBRO', 'RETENCIONES', '1.1.04.03'),
      ('CONSUMO_PRODUCCION', 'PRODUCCION_EN_PROCESO', '1.1.05.03'),
      ('CONSUMO_PRODUCCION', 'MATERIA_PRIMA', '1.1.05.01'),
      ('CONSUMO_PRODUCCION', 'INSUMO', '1.1.05.02'),
      ('CONVERSION_PRODUCCION', 'PRODUCCION_EN_PROCESO', '1.1.05.03'),
      ('CONVERSION_PRODUCCION', 'MANO_DE_OBRA_APLICADA', '5.1.02.01'),
      ('CONVERSION_PRODUCCION', 'CARGA_FABRIL_APLICADA', '5.1.02.02'),
      ('PRODUCCION_TERMINADA', 'PRODUCTO_TERMINADO', '1.1.05.04'),
      ('PRODUCCION_TERMINADA', 'PRODUCCION_EN_PROCESO', '1.1.05.03'),
      ('SUELDOS', 'REMUNERACIONES', '5.2.01.01'),
      ('SUELDOS', 'CONTRIBUCIONES', '5.2.01.02'),
      ('SUELDOS', 'MANO_DE_OBRA_DIRECTA', '5.1.03.01'),
      ('SUELDOS', 'SUELDOS_A_PAGAR', '2.1.03.01'),
      ('SUELDOS', 'CARGAS_SOCIALES_A_PAGAR', '2.1.03.02'),
      ('SUELDOS', 'SINDICATOS_A_PAGAR', '2.1.03.03'),
      ('PAGO_SUELDOS', 'SUELDOS_A_PAGAR', '2.1.03.01'),
      ('PAGO_CARGAS_SOCIALES', 'CARGAS_SOCIALES_A_PAGAR', '2.1.03.02'),
      ('PAGO_CARGAS_SOCIALES', 'SINDICATOS_A_PAGAR', '2.1.03.03'),
      ('IVA', 'IVA_DEBITO', '2.1.04.01'),
      ('IVA', 'IVA_CREDITO', '1.1.04.01'),
      ('IVA', 'IVA_A_PAGAR', '2.1.04.02'),
      ('PAGO_IVA', 'IVA_A_PAGAR', '2.1.04.02'),
      ('IIBB', 'IMPUESTO', '5.2.03.01'),
      ('IIBB', 'RETENCIONES', '1.1.04.03'),
      ('IIBB', 'IIBB_A_PAGAR', '2.1.04.03'),
      ('PAGO_IIBB', 'IIBB_A_PAGAR', '2.1.04.03')
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

-- La alícuota de ingresos brutos si el docente no la cambió (IIBB_DEFAULT_PCT, a validar).
create or replace function private.iibb_default_pct()
returns numeric
language sql
immutable
set search_path = ''
as $$ select 3::numeric $$;

-- ------------------------------------------------------------------ Listas de materiales de la demo (a validar)
create or replace function private.demo_bom_rows()
returns table (product text, line_no int, component text, quantity numeric)
language sql
immutable
set search_path = ''
as $$
  select b.product::text, b.line_no::int, b.component::text, b.quantity::numeric
    from (values
      ('PT-001', 1, 'MP-007', 1),
      ('PT-001', 2, 'MP-003', 24),
      ('PT-001', 3, 'MP-001', 10),
      ('PT-001', 4, 'IN-001', 0.3),
      ('PT-001', 5, 'IN-002', 1.5),
      ('PT-001', 6, 'IN-003', 0.1),
      ('PT-001', 7, 'IN-006', 6),
      ('PT-001', 8, 'IN-007', 0.1),
      ('PT-002', 1, 'MP-002', 18),
      ('PT-002', 2, 'IN-001', 0.1),
      ('PT-002', 3, 'IN-002', 0.4),
      ('PT-002', 4, 'IN-003', 0.04),
      ('PT-002', 5, 'IN-006', 2),
      ('PT-002', 6, 'IN-007', 0.03),
      ('PT-003', 1, 'MP-004', 2),
      ('PT-003', 2, 'MP-005', 1),
      ('PT-003', 3, 'IN-004', 4),
      ('PT-003', 4, 'IN-005', 2),
      ('PT-003', 5, 'IN-003', 0.2),
      ('PT-003', 6, 'IN-007', 0.2),
      ('PT-004', 1, 'MP-002', 60),
      ('PT-004', 2, 'MP-003', 30),
      ('PT-004', 3, 'MP-006', 0.5),
      ('PT-004', 4, 'IN-001', 0.3),
      ('PT-004', 5, 'IN-002', 1.5),
      ('PT-004', 6, 'IN-003', 0.15),
      ('PT-004', 7, 'IN-006', 6),
      ('PT-004', 8, 'IN-007', 0.15)
    ) as b (product, line_no, component, quantity)
$$;

-- Carga las listas de la demo por código (insertBoms): sólo para los productos
-- terminados que existen y todavía no tienen, y si todos sus componentes existen
-- y son materias primas o insumos.
create or replace function private.insert_demo_boms(p_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product public.products;
  v_bom uuid;
begin
  for v_product in
    select p.* from public.products p
     where p.company_id = p_company and p.product_type = 'PRODUCTO_TERMINADO'
       and p.code in (select r.product from private.demo_bom_rows() r)
       and not exists (select 1 from public.boms b where b.product_id = p.id)
     order by p.code collate "C"
  loop
    continue when exists (
      select 1 from private.demo_bom_rows() r
       where r.product = v_product.code
         and not exists (select 1 from public.products c
                          where c.company_id = p_company and c.code = r.component
                            and c.product_type in ('MATERIA_PRIMA', 'INSUMO')));
    insert into public.boms (company_id, product_id) values (p_company, v_product.id) returning id into v_bom;
    insert into public.bom_lines (company_id, bom_id, line_no, component_id, quantity)
    select p_company, v_bom, r.line_no, c.id, r.quantity
      from private.demo_bom_rows() r join public.products c on c.company_id = p_company and c.code = r.component
     where r.product = v_product.code;
  end loop;
end;
$$;

-- ------------------------------------------------------------------ Centros de trabajo y horas de la demo (a validar)
create or replace function private.demo_work_center_rows()
returns table (code text, name text, labor_rate numeric, overhead_rate numeric)
language sql
immutable
set search_path = ''
as $$
  select w.code::text, w.name::text, w.labor_rate::numeric, w.overhead_rate::numeric
    from (values
      ('CORTE', 'Corte y cepillado', 9000, 7000),
      ('ARMADO', 'Armado', 8500, 3500),
      ('TERMINACION', 'Terminación (lijado, barnizado y embalaje)', 8000, 4000)
    ) as w (code, name, labor_rate, overhead_rate)
$$;

-- Los centros de la demo que la empresa todavía no tiene, por código (insertWorkCenters).
create or replace function private.insert_demo_work_centers(p_company uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.work_centers (company_id, code, name, labor_rate, overhead_rate)
  select p_company, r.code, r.name, r.labor_rate, r.overhead_rate
    from private.demo_work_center_rows() r
   where not exists (select 1 from public.work_centers w where w.company_id = p_company and w.code = r.code)
$$;

create or replace function private.demo_bom_operation_rows()
returns table (product text, line_no int, center text, hours numeric)
language sql
immutable
set search_path = ''
as $$
  select o.product::text, o.line_no::int, o.center::text, o.hours::numeric
    from (values
      ('PT-001', 1, 'CORTE', 2.5),
      ('PT-001', 2, 'ARMADO', 1.5),
      ('PT-001', 3, 'TERMINACION', 1),
      ('PT-002', 1, 'CORTE', 0.6),
      ('PT-002', 2, 'ARMADO', 0.6),
      ('PT-002', 3, 'TERMINACION', 0.5),
      ('PT-003', 1, 'CORTE', 1.5),
      ('PT-003', 2, 'ARMADO', 2),
      ('PT-003', 3, 'TERMINACION', 0.5),
      ('PT-004', 1, 'CORTE', 1.5),
      ('PT-004', 2, 'ARMADO', 1.5),
      ('PT-004', 3, 'TERMINACION', 1.1)
    ) as o (product, line_no, center, hours)
$$;

-- Las horas de la demo en las listas de esos productos que todavía no tienen,
-- si existen todos sus centros de trabajo (insertBomOperations).
create or replace function private.insert_demo_bom_operations(p_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bom record;
begin
  for v_bom in
    select b.id, p.code from public.boms b join public.products p on p.id = b.product_id
     where b.company_id = p_company
       and p.code in (select r.product from private.demo_bom_operation_rows() r)
       and not exists (select 1 from public.bom_operations o where o.bom_id = b.id)
     order by p.code collate "C"
  loop
    continue when exists (
      select 1 from private.demo_bom_operation_rows() r
       where r.product = v_bom.code
         and not exists (select 1 from public.work_centers w where w.company_id = p_company and w.code = r.center));
    insert into public.bom_operations (company_id, bom_id, line_no, work_center_id, hours)
    select p_company, v_bom.id, r.line_no, w.id, r.hours
      from private.demo_bom_operation_rows() r join public.work_centers w on w.company_id = p_company and w.code = r.center
     where r.product = v_bom.code;
  end loop;
end;
$$;

-- ------------------------------------------------------------------ El personal de la demo (a validar)
-- Las horas de un mes completo de quien cobra por hora (MONTH_HOURS).
create or replace function private.month_hours()
returns numeric
language sql
immutable
set search_path = ''
as $$ select 176::numeric $$;

create or replace function private.demo_labor_agreement_rows()
returns table (code text, name text, union_name text, pay_basis text, seniority_pct numeric, attendance_pct numeric,
               union_pct numeric, union_employer_pct numeric)
language sql
immutable
set search_path = ''
as $$
  select a.code::text, a.name::text, a.union_name::text, a.pay_basis::text, a.seniority_pct::numeric,
         a.attendance_pct::numeric, a.union_pct::numeric, a.union_employer_pct::numeric
    from (values
      ('MADERA', 'Industria de la madera', 'UOMA', 'HOURLY', 1, 10, 2, 1),
      ('COMERCIO', 'Empleados de Comercio (CCT 130/75)', 'Empleados de Comercio', 'MONTHLY', 1, 8.33, 2.5, 1),
      ('CAMIONEROS', 'Camioneros (CCT 40/89)', 'Camioneros', 'MONTHLY', 1, 0, 3, 2),
      ('FUERA', 'Fuera de convenio', '', 'MONTHLY', 0, 0, 0, 0)
    ) as a (code, name, union_name, pay_basis, seniority_pct, attendance_pct, union_pct, union_employer_pct)
$$;

-- Los convenios de la demo que la empresa todavía no tiene, por código (insertLaborAgreements).
create or replace function private.insert_demo_labor_agreements(p_company uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.labor_agreements (company_id, code, name, union_name, pay_basis, seniority_pct, attendance_pct,
                                       union_pct, union_employer_pct)
  select p_company, r.code, r.name, r.union_name, r.pay_basis, r.seniority_pct, r.attendance_pct, r.union_pct,
         r.union_employer_pct
    from private.demo_labor_agreement_rows() r
   where not exists (select 1 from public.labor_agreements a where a.company_id = p_company and a.code = r.code)
$$;

-- Ahora cada categoría trae su convenio: cambia lo que devuelve, así que se vuelve a crear.
drop function if exists private.demo_job_category_rows();
create or replace function private.demo_job_category_rows()
returns table (code text, name text, agreement text, basic_salary numeric, is_direct_labor boolean)
language sql
immutable
set search_path = ''
as $$
  select c.code::text, c.name::text, c.agreement::text, c.basic_salary::numeric, c.is_direct_labor::boolean
    from (values
      ('OFICIAL', 'Oficial carpintero', 'MADERA', 7100, true),
      ('MEDIO-OF', 'Medio oficial', 'MADERA', 6250, true),
      ('AYUDANTE', 'Ayudante de taller', 'MADERA', 5400, true),
      ('ADMIN', 'Administrativo', 'COMERCIO', 1050000, false),
      ('VENDEDOR', 'Vendedor', 'COMERCIO', 1000000, false),
      ('OPERARIO', 'Operario de depósito', 'MADERA', 5570, false),
      ('ENCARGADO', 'Encargado general', 'FUERA', 1500000, false),
      ('CHOFER', 'Chofer', 'CAMIONEROS', 1150000, false)
    ) as c (code, name, agreement, basic_salary, is_direct_labor)
$$;

-- Las categorías de la demo que la empresa todavía no tiene, por código, cada una en su
-- convenio; si la empresa no tiene ese convenio, esa no (insertJobCategories).
create or replace function private.insert_demo_job_categories(p_company uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.job_categories (company_id, code, name, agreement_id, basic_salary, is_direct_labor)
  select p_company, r.code, r.name, a.id, r.basic_salary, r.is_direct_labor
    from private.demo_job_category_rows() r
    join public.labor_agreements a on a.company_id = p_company and a.code = r.agreement
   where not exists (select 1 from public.job_categories c where c.company_id = p_company and c.code = r.code)
$$;

create or replace function private.demo_employee_rows()
returns table (file_number int, first_name text, last_name text, hire_date date, category text, sector text,
               work_center text)
language sql
immutable
set search_path = ''
as $$
  select e.file_number::int, e.first_name::text, e.last_name::text, e.hire_date::date, e.category::text,
         e.sector::text, e.work_center::text
    from (values
      (1, 'Graciela', 'Paz', '2015-03-02', 'ENCARGADO', 'GER', null),
      (2, 'Ramón', 'Ortiz', '2015-04-06', 'OFICIAL', 'PRO', 'CORTE'),
      (3, 'Jorge', 'Cabral', '2016-08-01', 'OFICIAL', 'PRO', 'ARMADO'),
      (4, 'Patricia', 'Núñez', '2017-06-05', 'ADMIN', 'CON', null),
      (5, 'Hugo', 'Ledesma', '2018-10-01', 'MEDIO-OF', 'PRO', 'TERMINACION'),
      (6, 'Néstor', 'Galeano', '2019-03-11', 'MEDIO-OF', 'PRO', 'CORTE'),
      (7, 'Marcela', 'Ríos', '2019-09-02', 'VENDEDOR', 'VEN', null),
      (8, 'Elena', 'Duarte', '2020-02-03', 'MEDIO-OF', 'PRO', 'ARMADO'),
      (9, 'Oscar', 'Villalba', '2021-01-04', 'OPERARIO', 'DEP', null),
      (10, 'Silvia', 'Romero', '2023-05-02', 'AYUDANTE', 'PRO', 'TERMINACION'),
      (11, 'Walter', 'Aguirre', '2020-08-03', 'CHOFER', 'LOG', null)
    ) as e (file_number, first_name, last_name, hire_date, category, sector, work_center)
$$;

-- El personal de la demo, si la empresa todavía no tiene legajos: cada uno con su
-- categoría, su sector y su centro de trabajo por código; si falta alguno, ese no
-- (insertEmployees).
create or replace function private.insert_demo_employees(p_company uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.employees (company_id, file_number, first_name, last_name, hire_date, category_id, sector_id,
                                work_center_id)
  select p_company, r.file_number, r.first_name, r.last_name, r.hire_date, c.id, s.id, w.id
    from private.demo_employee_rows() r
    join public.job_categories c on c.company_id = p_company and c.code = r.category
    join public.sectors s on s.company_id = p_company and s.code = r.sector
    left join public.work_centers w on w.company_id = p_company and w.code = r.work_center
   where not exists (select 1 from public.employees x where x.company_id = p_company)
     and (r.work_center is null or w.id is not null)
$$;

-- El chofer de la demo (Fase 6d) en una empresa que ya tiene personal pero ningún chofer:
-- con el número de legajo siguiente (insertDriver).
create or replace function private.insert_demo_driver(p_company uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.employees (company_id, file_number, first_name, last_name, hire_date, category_id, sector_id)
  select p_company, (select max(x.file_number) + 1 from public.employees x where x.company_id = p_company),
         r.first_name, r.last_name, r.hire_date, c.id, s.id
    from private.demo_employee_rows() r
    join public.job_categories c on c.company_id = p_company and c.code = r.category
    join public.sectors s on s.company_id = p_company and s.code = r.sector
   where r.category = 'CHOFER'
     and exists (select 1 from public.employees x where x.company_id = p_company)
     and not exists (select 1 from public.employees x where x.category_id = c.id)
$$;

-- ------------------------------------------------------------------ El transporte de la demo (a validar)
create or replace function private.demo_carrier_rows()
returns table (code text, legal_name text, tax_id text, phone text)
language sql
immutable
set search_path = ''
as $$
  select c.code::text, c.legal_name::text, c.tax_id::text, c.phone::text
    from (values
      ('TR-001', 'Transportes Ruta 12 SRL', '30-00000107-0', ''),
      ('TR-002', 'Expreso Tierra Colorada SRL', '30-00000111-9', '')
    ) as c (code, legal_name, tax_id, phone)
$$;

-- Los transportistas de la demo que la empresa todavía no tiene, por código (insertCarriers).
create or replace function private.insert_demo_carriers(p_company uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.carriers (company_id, code, legal_name, tax_id, phone)
  select p_company, r.code, r.legal_name, r.tax_id, r.phone
    from private.demo_carrier_rows() r
   where not exists (select 1 from public.carriers c where c.company_id = p_company and c.code = r.code)
$$;

create or replace function private.demo_vehicle_rows()
returns table (code text, plate text, description text)
language sql
immutable
set search_path = ''
as $$
  select v.code::text, v.plate::text, v.description::text
    from (values
      ('CAM-01', 'AF 512 MS', 'Camión con caja cerrada para muebles (3,5 t)')
    ) as v (code, plate, description)
$$;

-- Los vehículos de la demo que la empresa todavía no tiene: ni su código ni su dominio
-- (insertVehicles).
create or replace function private.insert_demo_vehicles(p_company uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.vehicles (company_id, code, plate, description)
  select p_company, r.code, r.plate, r.description
    from private.demo_vehicle_rows() r
   where not exists (select 1 from public.vehicles v
                      where v.company_id = p_company and (v.code = r.code or v.plate = r.plate))
$$;

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

  -- Los centros de trabajo y las listas de materiales de los muebles, con sus horas.
  perform private.insert_demo_work_centers(v_id);
  perform private.insert_demo_boms(v_id);
  perform private.insert_demo_bom_operations(v_id);
  -- El personal: convenios, categorías y legajos (a validar).
  perform private.insert_demo_labor_agreements(v_id);
  perform private.insert_demo_job_categories(v_id);
  perform private.insert_demo_employees(v_id);
  -- El transporte: los fletes contratados y el camión propio (a validar).
  perform private.insert_demo_carriers(v_id);
  perform private.insert_demo_vehicles(v_id);

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
