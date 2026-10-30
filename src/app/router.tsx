import { lazy, type ComponentType } from 'react'
import { createBrowserRouter, Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { LoginPage } from '@/features/auth/login-page'
import { CompanyRoute, HomeRedirect, RequireAuth } from '@/features/auth/guards'
import { AppShell } from './layouts/app-shell'

/**
 * Carga diferida: el código de cada pantalla se descarga recién cuando se
 * visita (Tarea 3 del plan de continuación). Quedan en el paquete inicial
 * sólo el ingreso, los guardias y el marco de la aplicación, que se usan
 * siempre. Los límites de <Suspense> están en RequireAuth y en AppShell.
 */
function lazyPage<P extends object>(load: () => Promise<ComponentType<P>>) {
  return lazy(async () => ({ default: await load() }))
}

const AdminPage = lazyPage(() => import('@/features/admin/admin-page').then((m) => m.AdminPage))
const CompanySelectPage = lazyPage(() =>
  import('@/features/company/company-select-page').then((m) => m.CompanySelectPage),
)
const ChangePasswordPage = lazyPage(() =>
  import('@/features/auth/change-password-page').then((m) => m.ChangePasswordPage),
)
const ProfilePage = lazyPage(() => import('@/features/auth/profile-page').then((m) => m.ProfilePage))
const DashboardPage = lazyPage(() => import('@/features/dashboard/dashboard-page').then((m) => m.DashboardPage))
const LiveMapPage = lazyPage(() => import('@/features/flow/live-map-page').then((m) => m.LiveMapPage))
const MyWorkPage = lazyPage(() => import('@/features/my-work/my-work-page').then((m) => m.MyWorkPage))
const NotificationsPage = lazyPage(() =>
  import('@/features/notifications/notifications-page').then((m) => m.NotificationsPage),
)
const DocumentListPage = lazyPage(() =>
  import('@/features/documents/document-list-page').then((m) => m.DocumentListPage),
)
const DocumentPage = lazyPage(() => import('@/features/documents/document-page').then((m) => m.DocumentPage))
const PrintPage = lazyPage(() => import('@/features/documents/print-page').then((m) => m.PrintPage))
const RequisitionFormPage = lazyPage(() =>
  import('@/features/purchasing/requisitions/requisition-form').then((m) => m.RequisitionFormPage),
)
const OrderFormPage = lazyPage(() => import('@/features/purchasing/orders/order-form').then((m) => m.OrderFormPage))
const ReceiptFormPage = lazyPage(() =>
  import('@/features/inventory/receipts/receipt-form').then((m) => m.ReceiptFormPage),
)
const DeliveryFormPage = lazyPage(() =>
  import('@/features/inventory/deliveries/delivery-form').then((m) => m.DeliveryFormPage),
)
const SalesOrderFormPage = lazyPage(() => import('@/features/sales/order-form').then((m) => m.SalesOrderFormPage))
const SalesQuoteFormPage = lazyPage(() => import('@/features/sales/order-form').then((m) => m.SalesQuoteFormPage))
const PriceListsPage = lazyPage(() => import('@/features/sales/price-lists-pages').then((m) => m.PriceListsPage))
const PriceListPage = lazyPage(() => import('@/features/sales/price-lists-pages').then((m) => m.PriceListPage))
const ProductionOrderFormPage = lazyPage(() =>
  import('@/features/production/order-form').then((m) => m.ProductionOrderFormPage),
)
const BomsPage = lazyPage(() => import('@/features/production/boms-pages').then((m) => m.BomsPage))
const BomPage = lazyPage(() => import('@/features/production/boms-pages').then((m) => m.BomPage))
const WorkCentersPage = lazyPage(() => import('@/features/production/work-centers-page').then((m) => m.WorkCentersPage))
const ProductionCostsPage = lazyPage(() =>
  import('@/features/production/costs-page').then((m) => m.ProductionCostsPage),
)
const ProductionNeedsPage = lazyPage(() =>
  import('@/features/production/needs-page').then((m) => m.ProductionNeedsPage),
)
const EmployeesPage = lazyPage(() => import('@/features/hr/employees-page').then((m) => m.EmployeesPage))
const JobCategoriesPage = lazyPage(() => import('@/features/hr/categories-page').then((m) => m.JobCategoriesPage))
const LaborAgreementsPage = lazyPage(() => import('@/features/hr/agreements-page').then((m) => m.LaborAgreementsPage))
const PayrollFormPage = lazyPage(() => import('@/features/hr/payroll').then((m) => m.PayrollFormPage))
const LaborVariancePage = lazyPage(() => import('@/features/hr/labor-variance-page').then((m) => m.LaborVariancePage))
const TaxReturnFormPage = lazyPage(() => import('@/features/tax/tax-return').then((m) => m.TaxReturnFormPage))
const IvaBooksPage = lazyPage(() => import('@/features/tax/iva-books-page').then((m) => m.IvaBooksPage))
const ObligationsPage = lazyPage(() => import('@/features/tax/obligations-page').then((m) => m.ObligationsPage))
const TransportPage = lazyPage(() => import('@/features/logistics/transport-page').then((m) => m.TransportPage))
const RouteSheetFormPage = lazyPage(() => import('@/features/logistics/route-sheet').then((m) => m.RouteSheetFormPage))
const SalesInvoiceFormPage = lazyPage(() => import('@/features/sales/invoice-form').then((m) => m.SalesInvoiceFormPage))
const CollectionFormPage = lazyPage(() => import('@/features/sales/collection-form').then((m) => m.CollectionFormPage))
const ReceivablesPage = lazyPage(() => import('@/features/sales/receivables-pages').then((m) => m.ReceivablesPage))
const CustomerAccountPage = lazyPage(() =>
  import('@/features/sales/receivables-pages').then((m) => m.CustomerAccountPage),
)
const AdjustmentFormPage = lazyPage(() =>
  import('@/features/inventory/adjustments/adjustment-form').then((m) => m.AdjustmentFormPage),
)
const StockPage = lazyPage(() => import('@/features/inventory/stock/stock-page').then((m) => m.StockPage))
const ProductsPage = lazyPage(() => import('@/features/products/products-page').then((m) => m.ProductsPage))
const ProductDetailPage = lazyPage(() =>
  import('@/features/products/product-detail-page').then((m) => m.ProductDetailPage),
)
const PartnersPage = lazyPage(() => import('@/features/customers/partners-page').then((m) => m.PartnersPage))
const AuditPage = lazyPage(() => import('@/features/audit/audit-page').then((m) => m.AuditPage))
const CompanyPage = lazyPage(() => import('@/features/company/company-page').then((m) => m.CompanyPage))
const TeacherPage = lazyPage(() => import('@/features/teacher/teacher-page').then((m) => m.TeacherPage))
const AccountsPage = lazyPage(() => import('@/features/accounting/accounts-page').then((m) => m.AccountsPage))
const EntryFormPage = lazyPage(() => import('@/features/accounting/entry-form').then((m) => m.EntryFormPage))
const JournalPage = lazyPage(() => import('@/features/accounting/book-pages').then((m) => m.JournalPage))
const LedgerPage = lazyPage(() => import('@/features/accounting/book-pages').then((m) => m.LedgerPage))
const TrialBalancePage = lazyPage(() => import('@/features/accounting/book-pages').then((m) => m.TrialBalancePage))
const FiscalYearsPage = lazyPage(() => import('@/features/accounting/fiscal-years-page').then((m) => m.FiscalYearsPage))
const BookPrintPage = lazyPage(() => import('@/features/accounting/book-print-page').then((m) => m.BookPrintPage))
const PostingRulesPage = lazyPage(() =>
  import('@/features/accounting/posting-rules-page').then((m) => m.PostingRulesPage),
)
const InvoiceFormPage = lazyPage(() =>
  import('@/features/purchasing/invoices/invoice-form').then((m) => m.InvoiceFormPage),
)
const PayablesPage = lazyPage(() => import('@/features/payables/payables-pages').then((m) => m.PayablesPage))
const SupplierAccountPage = lazyPage(() =>
  import('@/features/payables/payables-pages').then((m) => m.SupplierAccountPage),
)
const TreasuryPage = lazyPage(() => import('@/features/payables/payables-pages').then((m) => m.TreasuryPage))
const PaymentOrderFormPage = lazyPage(() =>
  import('@/features/payables/payment-order-form').then((m) => m.PaymentOrderFormPage),
)
const TransferFormPage = lazyPage(() => import('@/features/payables/transfer-form').then((m) => m.TransferFormPage))
const CashFlowPage = lazyPage(() => import('@/features/payables/cash-flow-page').then((m) => m.CashFlowPage))
const IssuedChequesPage = lazyPage(() => import('@/features/payables/payables-pages').then((m) => m.IssuedChequesPage))
const ReconciliationFormPage = lazyPage(() =>
  import('@/features/payables/reconciliation-form').then((m) => m.ReconciliationFormPage),
)
const RfqFormPage = lazyPage(() => import('@/features/purchasing/quotations/rfq-form').then((m) => m.RfqFormPage))
const QuoteFormPage = lazyPage(() => import('@/features/purchasing/quotations/quote-form').then((m) => m.QuoteFormPage))

function NotFound() {
  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <h1 className="text-lg font-semibold text-navy">Página no encontrada</h1>
      <Button asChild className="mt-6">
        <Link to="/">Ir al inicio</Link>
      </Button>
    </div>
  )
}

export const router = createBrowserRouter(
  [
    { path: '/login', element: <LoginPage /> },
    {
      element: <RequireAuth />,
      children: [
        { path: '/', element: <HomeRedirect /> },
        { path: '/empresas', element: <CompanySelectPage /> },
        { path: '/cambiar-contrasena', element: <ChangePasswordPage /> },
        { path: '/perfil', element: <ProfilePage /> },
        { path: '/admin', element: <AdminPage /> },
        { path: '/admin/cursos', element: <AdminPage /> },
        { path: '/admin/escuela', element: <AdminPage /> },
        {
          path: '/e/:slug',
          element: <CompanyRoute />,
          children: [
            { path: 'documentos/:docId/imprimir', element: <PrintPage /> },
            { path: 'contabilidad/imprimir/:book', element: <BookPrintPage /> },
            {
              element: <AppShell />,
              children: [
                { index: true, element: <DashboardPage /> },
                { path: 'mapa-vivo', element: <LiveMapPage /> },
                { path: 'mi-trabajo', element: <MyWorkPage /> },
                { path: 'notificaciones', element: <NotificationsPage /> },
                { path: 'compras/solicitudes', element: <DocumentListPage key="pr" docType="PURCHASE_REQUISITION" /> },
                { path: 'compras/solicitudes/nueva', element: <RequisitionFormPage /> },
                {
                  path: 'compras/solicitudes/:number',
                  element: <DocumentPage key="pr" docType="PURCHASE_REQUISITION" />,
                },
                { path: 'compras/solicitudes/:number/editar', element: <RequisitionFormPage /> },
                { path: 'compras/ordenes', element: <DocumentListPage key="po" docType="PURCHASE_ORDER" /> },
                { path: 'compras/ordenes/nueva', element: <OrderFormPage /> },
                { path: 'compras/ordenes/:number', element: <DocumentPage key="po" docType="PURCHASE_ORDER" /> },
                { path: 'compras/ordenes/:number/editar', element: <OrderFormPage /> },
                { path: 'compras/solicitudes-cotizacion', element: <DocumentListPage key="rq" docType="RFQ" /> },
                { path: 'compras/solicitudes-cotizacion/nueva', element: <RfqFormPage /> },
                { path: 'compras/solicitudes-cotizacion/:number', element: <DocumentPage key="rq" docType="RFQ" /> },
                { path: 'compras/cotizaciones', element: <DocumentListPage key="sq" docType="SUPPLIER_QUOTE" /> },
                { path: 'compras/cotizaciones/nueva', element: <QuoteFormPage /> },
                {
                  path: 'compras/cotizaciones/:number',
                  element: <DocumentPage key="sq" docType="SUPPLIER_QUOTE" />,
                },
                { path: 'compras/facturas', element: <DocumentListPage key="si" docType="SUPPLIER_INVOICE" /> },
                { path: 'compras/facturas/nueva', element: <InvoiceFormPage /> },
                { path: 'compras/facturas/:number', element: <DocumentPage key="si" docType="SUPPLIER_INVOICE" /> },
                { path: 'pagos/proveedores', element: <PayablesPage /> },
                { path: 'pagos/proveedores/:code', element: <SupplierAccountPage /> },
                { path: 'pagos/ordenes', element: <DocumentListPage key="op" docType="PAYMENT_ORDER" /> },
                { path: 'pagos/ordenes/nueva', element: <PaymentOrderFormPage /> },
                { path: 'pagos/ordenes/:number', element: <DocumentPage key="op" docType="PAYMENT_ORDER" /> },
                { path: 'pagos/cobros', element: <DocumentListPage key="rc" docType="CUSTOMER_RECEIPT" /> },
                { path: 'pagos/cobros/nuevo', element: <CollectionFormPage /> },
                { path: 'pagos/cobros/:number', element: <DocumentPage key="rc" docType="CUSTOMER_RECEIPT" /> },
                { path: 'pagos/cajas-y-bancos', element: <TreasuryPage /> },
                { path: 'pagos/flujo-de-fondos', element: <CashFlowPage /> },
                { path: 'pagos/transferencias', element: <DocumentListPage key="ft" docType="FUNDS_TRANSFER" /> },
                { path: 'pagos/transferencias/nueva', element: <TransferFormPage /> },
                { path: 'pagos/transferencias/:number', element: <DocumentPage key="ft" docType="FUNDS_TRANSFER" /> },
                { path: 'pagos/cheques', element: <IssuedChequesPage /> },
                {
                  path: 'pagos/conciliaciones',
                  element: <DocumentListPage key="br" docType="BANK_RECONCILIATION" />,
                },
                { path: 'pagos/conciliaciones/nueva', element: <ReconciliationFormPage /> },
                {
                  path: 'pagos/conciliaciones/:number',
                  element: <DocumentPage key="br" docType="BANK_RECONCILIATION" />,
                },
                { path: 'contabilidad/imputacion', element: <PostingRulesPage /> },
                { path: 'deposito/recepciones', element: <DocumentListPage key="gr" docType="GOODS_RECEIPT" /> },
                { path: 'deposito/recepciones/nueva', element: <ReceiptFormPage /> },
                { path: 'deposito/recepciones/:number', element: <DocumentPage key="gr" docType="GOODS_RECEIPT" /> },
                { path: 'deposito/remitos', element: <DocumentListPage key="dn" docType="DELIVERY_NOTE" /> },
                { path: 'deposito/remitos/nuevo', element: <DeliveryFormPage /> },
                { path: 'deposito/remitos/:number', element: <DocumentPage key="dn" docType="DELIVERY_NOTE" /> },
                { path: 'ventas/presupuestos', element: <DocumentListPage key="qt" docType="SALES_QUOTE" /> },
                { path: 'ventas/presupuestos/nuevo', element: <SalesQuoteFormPage /> },
                { path: 'ventas/presupuestos/:number', element: <DocumentPage key="qt" docType="SALES_QUOTE" /> },
                { path: 'ventas/pedidos', element: <DocumentListPage key="so" docType="SALES_ORDER" /> },
                { path: 'ventas/pedidos/nuevo', element: <SalesOrderFormPage /> },
                { path: 'ventas/pedidos/:number', element: <DocumentPage key="so" docType="SALES_ORDER" /> },
                { path: 'ventas/facturas', element: <DocumentListPage key="fv" docType="SALES_INVOICE" /> },
                { path: 'ventas/facturas/nueva', element: <SalesInvoiceFormPage /> },
                { path: 'ventas/facturas/:number', element: <DocumentPage key="fv" docType="SALES_INVOICE" /> },
                { path: 'ventas/clientes', element: <ReceivablesPage /> },
                { path: 'ventas/clientes/:code', element: <CustomerAccountPage /> },
                { path: 'ventas/listas-de-precios', element: <PriceListsPage /> },
                { path: 'ventas/listas-de-precios/:code', element: <PriceListPage /> },
                { path: 'produccion/ordenes', element: <DocumentListPage key="pd" docType="PRODUCTION_ORDER" /> },
                { path: 'produccion/ordenes/nueva', element: <ProductionOrderFormPage /> },
                { path: 'produccion/ordenes/:number', element: <DocumentPage key="pd" docType="PRODUCTION_ORDER" /> },
                { path: 'produccion/listas-de-materiales', element: <BomsPage /> },
                { path: 'produccion/listas-de-materiales/:code', element: <BomPage /> },
                { path: 'produccion/centros-de-trabajo', element: <WorkCentersPage /> },
                { path: 'produccion/costos', element: <ProductionCostsPage /> },
                { path: 'produccion/necesidades', element: <ProductionNeedsPage /> },
                { path: 'rrhh/legajos', element: <EmployeesPage /> },
                { path: 'rrhh/categorias', element: <JobCategoriesPage /> },
                { path: 'rrhh/convenios', element: <LaborAgreementsPage /> },
                { path: 'rrhh/liquidaciones', element: <DocumentListPage key="py" docType="PAYROLL" /> },
                { path: 'rrhh/liquidaciones/nueva', element: <PayrollFormPage /> },
                { path: 'rrhh/liquidaciones/:number', element: <DocumentPage key="py" docType="PAYROLL" /> },
                { path: 'contabilidad/mano-de-obra', element: <LaborVariancePage /> },
                { path: 'impuestos/declaraciones', element: <DocumentListPage key="dj" docType="TAX_RETURN" /> },
                { path: 'impuestos/declaraciones/nueva', element: <TaxReturnFormPage /> },
                { path: 'impuestos/declaraciones/:number', element: <DocumentPage key="dj" docType="TAX_RETURN" /> },
                { path: 'impuestos/libros-iva', element: <IvaBooksPage /> },
                { path: 'impuestos/vencimientos', element: <ObligationsPage /> },
                { path: 'logistica/transporte', element: <TransportPage /> },
                { path: 'logistica/hojas-de-ruta', element: <DocumentListPage key="hr" docType="ROUTE_SHEET" /> },
                { path: 'logistica/hojas-de-ruta/nueva', element: <RouteSheetFormPage /> },
                { path: 'logistica/hojas-de-ruta/:number', element: <DocumentPage key="hr" docType="ROUTE_SHEET" /> },
                { path: 'stock', element: <StockPage /> },
                { path: 'stock/ajustes', element: <DocumentListPage key="sa" docType="STOCK_ADJUSTMENT" /> },
                { path: 'stock/ajustes/nuevo', element: <AdjustmentFormPage /> },
                { path: 'stock/ajustes/:number', element: <DocumentPage key="sa" docType="STOCK_ADJUSTMENT" /> },
                { path: 'contabilidad/asientos', element: <DocumentListPage key="je" docType="JOURNAL_ENTRY" /> },
                { path: 'contabilidad/asientos/nuevo', element: <EntryFormPage /> },
                { path: 'contabilidad/asientos/:number', element: <DocumentPage key="je" docType="JOURNAL_ENTRY" /> },
                { path: 'contabilidad/asientos/:number/editar', element: <EntryFormPage /> },
                { path: 'contabilidad/diario', element: <JournalPage /> },
                { path: 'contabilidad/mayor', element: <LedgerPage /> },
                { path: 'contabilidad/sumas-y-saldos', element: <TrialBalancePage /> },
                { path: 'contabilidad/plan-de-cuentas', element: <AccountsPage /> },
                { path: 'contabilidad/ejercicios', element: <FiscalYearsPage /> },
                { path: 'productos', element: <ProductsPage /> },
                { path: 'productos/:code', element: <ProductDetailPage /> },
                { path: 'proveedores', element: <PartnersPage key="supplier" kind="supplier" /> },
                { path: 'clientes', element: <PartnersPage key="customer" kind="customer" /> },
                { path: 'auditoria', element: <AuditPage /> },
                { path: 'empresa', element: <CompanyPage /> },
                { path: 'docente', element: <TeacherPage /> },
                { path: '*', element: <NotFound /> },
              ],
            },
          ],
        },
      ],
    },
    { path: '*', element: <NotFound /> },
  ],
  // El sitio puede publicarse en una subruta (GitHub Pages: /integrar-erp/).
  { basename: import.meta.env.BASE_URL.replace(/\/+$/, '') || '/' },
)
