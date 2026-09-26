import { createContext, useContext, type ReactNode } from 'react'
import type { CompanyContext } from '@/lib/api'
import { DOC_TYPES } from '@/lib/domain/catalog'
import type { DocType } from '@/lib/domain/types'

export interface CompanyValue extends CompanyContext {
  companyId: string
  slug: string
  can: (permission: string) => boolean
  /** Ruta absoluta dentro de la empresa: to('compras/ordenes') → /e/slug/compras/ordenes */
  to: (sub?: string) => string
  docPath: (docType: DocType, number?: string) => string
}

const Ctx = createContext<CompanyValue | null>(null)

export function CompanyProvider({ context, children }: { context: CompanyContext; children: ReactNode }) {
  const slug = context.company.slug
  const perms = new Set(context.permissions)
  const value: CompanyValue = {
    ...context,
    companyId: context.company.id,
    slug,
    can: (permission) => context.all || perms.has(permission),
    to: (sub) => `/e/${slug}${sub ? `/${sub}` : ''}`,
    docPath: (docType, number) => `/e/${slug}/${DOC_TYPES[docType].path}${number ? `/${number}` : ''}`,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useCompany() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useCompany fuera de CompanyProvider')
  return ctx
}
