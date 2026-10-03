-- 13. Empresa plantilla de demostración: FORESTAL DEL NORTE SRL (datos ficticios).
-- GENERADO por scripts/generate-demo-sql.mjs desde src/lib/mock/seed.ts: no editar a mano.
-- Se ejecuta al instalar una escuela (docs/INSTANCIAS.md): select private.seed_demo_company();
-- Idempotente: si la plantilla ya existe, devuelve su id sin tocarla.

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

  -- Inventario inicial documentado (un ajuste por depósito) y alertas de arranque.
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
  perform private.scan_stock_alerts(v_id);
  return v_id;
end;
$$;
