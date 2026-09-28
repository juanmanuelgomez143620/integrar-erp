import { createBrowserRouter, Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { LoginPage } from '@/features/auth/login-page'
import { CompanyRoute, CompanySelectPage, HomeRedirect, RequireAuth } from '@/features/auth/guards'
import { DashboardPage } from '@/features/dashboard/dashboard-page'
import { MyWorkPage } from '@/features/my-work/my-work-page'
import { DocumentListPage } from '@/features/documents/document-list-page'
import { DocumentPage } from '@/features/documents/document-page'
import { PrintPage } from '@/features/documents/print-page'
import { RequisitionFormPage } from '@/features/purchasing/requisitions/requisition-form'
import { OrderFormPage } from '@/features/purchasing/orders/order-form'
import { ReceiptFormPage } from '@/features/inventory/receipts/receipt-form'
import { AdjustmentFormPage } from '@/features/inventory/adjustments/adjustment-form'
import { StockPage } from '@/features/inventory/stock/stock-page'
import { ProductsPage } from '@/features/products/products-page'
import { ProductDetailPage } from '@/features/products/product-detail-page'
import { PartnersPage } from '@/features/customers/partners-page'
import { AuditPage } from '@/features/audit/audit-page'
import { CompanyPage } from '@/features/company/company-page'
import { TeacherPage } from '@/features/teacher/teacher-page'
import { AppShell } from './layouts/app-shell'

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

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: '/', element: <HomeRedirect /> },
      { path: '/empresas', element: <CompanySelectPage /> },
      {
        path: '/e/:slug',
        element: <CompanyRoute />,
        children: [
          { path: 'documentos/:docId/imprimir', element: <PrintPage /> },
          {
            element: <AppShell />,
            children: [
              { index: true, element: <DashboardPage /> },
              { path: 'mi-trabajo', element: <MyWorkPage /> },
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
              { path: 'deposito/recepciones', element: <DocumentListPage key="gr" docType="GOODS_RECEIPT" /> },
              { path: 'deposito/recepciones/nueva', element: <ReceiptFormPage /> },
              { path: 'deposito/recepciones/:number', element: <DocumentPage key="gr" docType="GOODS_RECEIPT" /> },
              { path: 'stock', element: <StockPage /> },
              { path: 'stock/ajustes', element: <DocumentListPage key="sa" docType="STOCK_ADJUSTMENT" /> },
              { path: 'stock/ajustes/nuevo', element: <AdjustmentFormPage /> },
              { path: 'stock/ajustes/:number', element: <DocumentPage key="sa" docType="STOCK_ADJUSTMENT" /> },
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
])
