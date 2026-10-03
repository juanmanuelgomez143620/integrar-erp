import { lazy, type ComponentType } from 'react'
import { createBrowserRouter, Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { LoginPage } from '@/features/auth/login-page'
import { CompanyRoute, CompanySelectPage, HomeRedirect, RequireAuth } from '@/features/auth/guards'
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
const ChangePasswordPage = lazyPage(() =>
  import('@/features/auth/change-password-page').then((m) => m.ChangePasswordPage),
)
const ProfilePage = lazyPage(() => import('@/features/auth/profile-page').then((m) => m.ProfilePage))
const DashboardPage = lazyPage(() => import('@/features/dashboard/dashboard-page').then((m) => m.DashboardPage))
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
          {
            element: <AppShell />,
            children: [
              { index: true, element: <DashboardPage /> },
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
