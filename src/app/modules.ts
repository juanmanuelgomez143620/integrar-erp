// Registro del menú lateral. Cada ítem se muestra sólo si el usuario tiene el
// permiso (y el docente no bloqueó el módulo: eso ya lo resuelve el permiso efectivo).

import type { ComponentType } from 'react'
import {
  Bell,
  BookMarked,
  BookOpen,
  Boxes,
  Building2,
  CalendarRange,
  ClipboardList,
  GraduationCap,
  History,
  Inbox,
  LayoutDashboard,
  ListTree,
  NotebookPen,
  Package,
  PackageCheck,
  ReceiptText,
  Scale,
  ShoppingCart,
  SlidersHorizontal,
  Truck,
  Users,
  Wallet,
  Workflow,
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
    label: 'Pagos y tesorería',
    items: [{ label: 'Cuentas corrientes', path: 'pagos/proveedores', icon: Wallet, permission: 'payable.read' }],
  },
  {
    label: 'Depósito',
    items: [
      { label: 'Recepciones', path: 'deposito/recepciones', icon: PackageCheck, permission: 'goods_receipt.read' },
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
