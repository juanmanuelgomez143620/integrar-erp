# Glosario — términos del dominio e identificadores técnicos

> La interfaz y la documentación usan los términos en español; el código y la base de datos, los identificadores en inglés.

## Organización

| Término | Identificador | Definición |
|---|---|---|
| Instancia | — | Instalación independiente del sistema para una escuela (base, usuarios y sitio propios) |
| Escuela | `school_settings` | Datos de la escuela dueña de la instancia (una sola fila) |
| Curso | `courses` | División de un año lectivo (p. ej. "5.º A — 2027") |
| Empresa simulada | `companies` | Organización ficticia que opera un curso o grupo |
| Plantilla | `companies.is_template` | Empresa modelo que se clona para cada curso |
| Sucursal | `branches` | Establecimiento de la empresa (planta, local) |
| Depósito | `warehouses` | Lugar físico donde se guarda el stock |
| Centro de costo | `cost_centers` | Unidad a la que se imputan costos |
| Sector | `sectors` | Área de la empresa (Compras, Depósito…) |
| Isla | `islands` | Grupo de trabajo físico del aula que agrupa sectores |
| Miembro | `company_members` | Usuario que participa en una empresa |
| Rol funcional | `roles` / `member_roles` | Puesto que el usuario ocupa en la empresa; define sus permisos |
| Permiso | `permissions` | Acción autorizada sobre un recurso (`purchase_order.approve`) |
| Módulo | `modules` | Conjunto funcional que el docente puede habilitar o bloquear |

## Maestros

| Término | Identificador | Definición |
|---|---|---|
| Cliente | `customers` | Tercero que compra a la empresa |
| Proveedor | `suppliers` | Tercero que vende a la empresa |
| Producto | `products` | Bien o servicio que la empresa compra, fabrica o vende |
| Materia prima | `MATERIA_PRIMA` | Bien que se transforma en producción (tablas, placas) |
| Insumo | `INSUMO` | Bien que se consume sin ser el componente principal (cola, tornillos) |
| Producto terminado | `PRODUCTO_TERMINADO` | Resultado de la producción, listo para vender |
| Mercadería de reventa | `MERCADERIA_REVENTA` | Bien que se compra y se vende sin transformar |
| Unidad de medida | `units_of_measure` | UN, KG, L, PIE (pie cuadrado de madera)… |
| Condición frente al IVA | `vat_condition` | Responsable inscripto, monotributo, exento, consumidor final |
| Stock mínimo | `min_stock` | Cantidad por debajo de la cual se debe reponer |

## Documentos y flujo

| Término | Identificador | Prefijo | Definición |
|---|---|---|---|
| Documento / comprobante | `documents` | — | Registro numerado de una operación, con estado e historial |
| Solicitud de compra | `purchase_requisitions` | SC | Pedido interno de un sector a Compras |
| Orden de compra | `purchase_orders` | OC | Compromiso formal de compra con un proveedor |
| Recepción de mercadería | `goods_receipts` | REC | Constancia de lo efectivamente recibido contra una OC |
| Remito (del proveedor) | `supplier_delivery_note` | — | Documento del proveedor que acompaña la mercadería |
| Ajuste de stock | `stock_adjustments` | AJS | Corrección documentada del stock |
| Estado | `status` | — | Etapa del ciclo de vida de un documento |
| Transición | `document_transitions` | — | Paso permitido de un estado a otro, con su permiso |
| Flujo documental | `document_links` | — | Cadena de documentos relacionados (SC → OC → REC) |
| Tarea | `tasks` | — | Intervención pendiente de un rol o persona ("Mi trabajo") |
| Aprobación | `approval_requests` | — | Decisión de autorizar o rechazar un documento |
| Regla de aprobación | `approval_rules` | — | Quién aprueba según tipo de documento y monto |
| Separación de funciones | `sod_enabled` | — | Control interno: quien ejecuta no autoriza su propia operación |
| Notificación | `notifications` | — | Aviso a un usuario |
| Auditoría | `audit_events` | — | Registro inmutable de quién hizo qué y cuándo |

## Stock y costos

| Término | Identificador | Definición |
|---|---|---|
| Movimiento de stock | `stock_movements` | Entrada o salida de un producto en un depósito |
| Kardex | vista sobre `stock_movements` | Ficha de movimientos de un producto con saldo posterior |
| Saldo de stock | `stock_balances` | Cantidad disponible por producto y depósito |
| PPP | `avg_unit_cost` | Precio (costo) promedio ponderado |
| Inventario permanente | — | Método por el cual el stock y su costo se actualizan con cada movimiento |

## Fases futuras

| Término | Identificador | Prefijo |
|---|---|---|
| Solicitud de cotización | `rfqs` | SCT |
| Cotización de proveedor | `supplier_quotes` | COT |
| Factura de proveedor | `supplier_invoices` | FCP |
| Orden de pago | `payment_orders` | OP |
| Cuenta corriente | `*_ledger_entries` | — |
| Presupuesto | `sales_quotes` | PRE |
| Pedido de venta | `sales_orders` | PV |
| Remito (propio) | `delivery_notes` | REM |
| Factura de venta | `sales_invoices` | FV |
| Recibo de cobro | `customer_receipts` | RBO |
| Lista de materiales | `bills_of_materials` | — |
| Orden de producción | `production_orders` | OPR |
| Plan de cuentas | `accounts` | — |
| Asiento contable | `journal_entries` | AS |
| Regla de imputación | `posting_rules` | — |
| Legajo | `employees` | — |
| Novedad de RRHH | `hr_events` | — |
| Liquidación de sueldos | `payroll_runs` | LIQ |
| Recibo de sueldo | `payslips` | — |
| Obligación impositiva | `tax_obligations` | — |
| Despacho | `shipments` | DES |
| Escenario | `scenarios` / `scenario_runs` | — |
| Consigna | `assignments` | — |
