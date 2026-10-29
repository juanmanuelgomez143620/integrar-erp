// Registro del menú lateral. Cada ítem se muestra sólo si el usuario tiene el
// permiso (y el docente no bloqueó el módulo: eso ya lo resuelve el permiso efectivo).

import type { ComponentType } from 'react'
import {
  ArrowLeftRight,
  BadgeDollarSign,
  Banknote,
  Bell,
  BookMarked,
  BookOpen,
  Calculator,
  Boxes,
  BriefcaseBusiness,
  Building2,
  CalendarRange,
  ClipboardCheck,
  BookCheck,
  FileCheck,
  ClipboardList,
  Coins,
  Factory,
  FilePen,
  FileSearch,
  GraduationCap,
  Hammer,
  HandCoins,
  Handshake,
  History,
  IdCard,
  Inbox,
  Landmark,
  Layers,
  LayoutDashboard,
  ListTree,
  Network,
  NotebookPen,
  Package,
  PackageCheck,
  PackageOpen,
  PackageSearch,
  ReceiptText,
  Scale,
  ScrollText,
  ShoppingCart,
  SlidersHorizontal,
  Tags,
  TrendingUp,
  Truck,
  Users,
  Wallet,
  Workflow,
  Wrench,
} from 'lucide-react'

export interface NavItem {
  label: string
  path: string
  icon: ComponentType<{ className?: string }>
  permission?: string
  supervisorOnly?: boolean
  badge?: 'tasks'
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

export const NAV: NavGroup[] = [
  {
    label: 'General',
    items: [
      { label: 'Inicio', path: '', icon: LayoutDashboard },
      { label: 'Mi trabajo', path: 'mi-trabajo', icon: Inbox, badge: 'tasks' },
      { label: 'Mapa vivo', path: 'mapa-vivo', icon: Network },
      { label: 'Notificaciones', path: 'notificaciones', icon: Bell },
    ],
  },
  {
    label: 'Compras',
    items: [
      {
        label: 'Solicitudes de compra',
        path: 'compras/solicitudes',
        icon: ClipboardList,
        permission: 'purchase_requisition.read',
      },
      {
        label: 'Solicitudes de cotización',
        path: 'compras/solicitudes-cotizacion',
        icon: FileSearch,
        permission: 'rfq.read',
      },
      { label: 'Cotizaciones', path: 'compras/cotizaciones', icon: Tags, permission: 'supplier_quote.read' },
      { label: 'Órdenes de compra', path: 'compras/ordenes', icon: ShoppingCart, permission: 'purchase_order.read' },
      {
        label: 'Facturas de proveedores',
        path: 'compras/facturas',
        icon: ReceiptText,
        permission: 'supplier_invoice.read',
      },
    ],
  },
  {
    label: 'Ventas',
    items: [
      { label: 'Presupuestos', path: 'ventas/presupuestos', icon: FilePen, permission: 'sales_quote.read' },
      { label: 'Pedidos de venta', path: 'ventas/pedidos', icon: Handshake, permission: 'sales_order.read' },
      { label: 'Facturas de venta', path: 'ventas/facturas', icon: ReceiptText, permission: 'sales_invoice.read' },
      { label: 'Cuentas corrientes', path: 'ventas/clientes', icon: Wallet, permission: 'receivable.read' },
      {
        label: 'Listas de precios',
        path: 'ventas/listas-de-precios',
        icon: BadgeDollarSign,
        permission: 'price_list.read',
      },
    ],
  },
  {
    label: 'Pagos y tesorería',
    items: [
      { label: 'Cuentas corrientes', path: 'pagos/proveedores', icon: Wallet, permission: 'payable.read' },
      { label: 'Órdenes de pago', path: 'pagos/ordenes', icon: Banknote, permission: 'payment_order.read' },
      { label: 'Recibos de cobro', path: 'pagos/cobros', icon: HandCoins, permission: 'customer_receipt.read' },
      { label: 'Cajas y bancos', path: 'pagos/cajas-y-bancos', icon: Landmark, permission: 'treasury.read' },
      {
        label: 'Transferencias',
        path: 'pagos/transferencias',
        icon: ArrowLeftRight,
        permission: 'funds_transfer.read',
      },
      { label: 'Flujo de fondos', path: 'pagos/flujo-de-fondos', icon: TrendingUp, permission: 'treasury.read' },
      { label: 'Cheques emitidos', path: 'pagos/cheques', icon: ScrollText, permission: 'treasury.read' },
      {
        label: 'Conciliaciones bancarias',
        path: 'pagos/conciliaciones',
        icon: ClipboardCheck,
        permission: 'bank_reconciliation.read',
      },
    ],
  },
  {
    label: 'Depósito',
    items: [
      { label: 'Recepciones', path: 'deposito/recepciones', icon: PackageCheck, permission: 'goods_receipt.read' },
      { label: 'Remitos', path: 'deposito/remitos', icon: PackageOpen, permission: 'delivery_note.read' },
      { label: 'Stock', path: 'stock', icon: Boxes, permission: 'stock.read' },
      {
        label: 'Ajustes de stock',
        path: 'stock/ajustes',
        icon: SlidersHorizontal,
        permission: 'stock_adjustment.read',
      },
    ],
  },
  {
    label: 'Producción',
    items: [
      {
        label: 'Órdenes de producción',
        path: 'produccion/ordenes',
        icon: Factory,
        permission: 'production_order.read',
      },
      {
        label: 'Necesidades de materiales',
        path: 'produccion/necesidades',
        icon: PackageSearch,
        permission: 'production_order.read',
      },
      { label: 'Listas de materiales', path: 'produccion/listas-de-materiales', icon: Layers, permission: 'bom.read' },
      {
        label: 'Centros de trabajo',
        path: 'produccion/centros-de-trabajo',
        icon: Wrench,
        permission: 'work_center.read',
      },
      {
        label: 'Costos de producción',
        path: 'produccion/costos',
        icon: Calculator,
        permission: 'production_order.read',
      },
    ],
  },
  {
    label: 'RRHH',
    items: [
      { label: 'Legajos', path: 'rrhh/legajos', icon: IdCard, permission: 'employee.read' },
      { label: 'Liquidaciones', path: 'rrhh/liquidaciones', icon: Coins, permission: 'payroll.read' },
      { label: 'Categorías', path: 'rrhh/categorias', icon: BriefcaseBusiness, permission: 'employee.read' },
      { label: 'Convenios', path: 'rrhh/convenios', icon: Handshake, permission: 'employee.read' },
    ],
  },
  {
    label: 'Impuestos',
    items: [
      { label: 'Declaraciones', path: 'impuestos/declaraciones', icon: FileCheck, permission: 'tax_return.read' },
      { label: 'Libros IVA', path: 'impuestos/libros-iva', icon: BookCheck, permission: 'tax_return.read' },
    ],
  },
  {
    label: 'Contabilidad',
    items: [
      { label: 'Asientos', path: 'contabilidad/asientos', icon: NotebookPen, permission: 'journal_entry.read' },
      { label: 'Libro diario', path: 'contabilidad/diario', icon: BookOpen, permission: 'ledger.read' },
      { label: 'Libro mayor', path: 'contabilidad/mayor', icon: BookMarked, permission: 'ledger.read' },
      { label: 'Sumas y saldos', path: 'contabilidad/sumas-y-saldos', icon: Scale, permission: 'ledger.read' },
      { label: 'Plan de cuentas', path: 'contabilidad/plan-de-cuentas', icon: ListTree, permission: 'account.read' },
      {
        label: 'Ejercicios y períodos',
        path: 'contabilidad/ejercicios',
        icon: CalendarRange,
        permission: 'ledger.read',
      },
      {
        label: 'Imputación automática',
        path: 'contabilidad/imputacion',
        icon: Workflow,
        permission: 'posting_rule.read',
      },
      // Lo ven quienes ven las liquidaciones (docs/FASE_6_RRHH_Y_SUELDOS.md §4).
      { label: 'Mano de obra del taller', path: 'contabilidad/mano-de-obra', icon: Hammer, permission: 'payroll.read' },
    ],
  },
  {
    label: 'Maestros',
    items: [
      { label: 'Productos', path: 'productos', icon: Package, permission: 'product.read' },
      { label: 'Proveedores', path: 'proveedores', icon: Truck, permission: 'supplier.read' },
      { label: 'Clientes', path: 'clientes', icon: Users, permission: 'customer.read' },
    ],
  },
  {
    label: 'Control',
    items: [
      { label: 'Auditoría', path: 'auditoria', icon: History, permission: 'audit.read' },
      { label: 'Empresa', path: 'empresa', icon: Building2, permission: 'company.read' },
      { label: 'Panel docente', path: 'docente', icon: GraduationCap, supervisorOnly: true },
    ],
  },
]
