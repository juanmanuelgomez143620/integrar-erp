// Backend real: Supabase, con el mismo contrato que el simulado (index.ts).
//
// Cada consulta es una función de lectura SQL que devuelve exactamente lo
// mismo que su equivalente de queries.ts (supabase/tests/reads.test.ts lo
// compara) y cada comando, la RPC equivalente del motor. Las cuentas (altas y
// contraseñas de otros) pasan por la Edge Function "admin-users". Sin
// dependencias: fetch a PostgREST, a Auth y a la función.
//
// La actualización entre sectores es por sondeo: "invalidación al operar +
// sondeo; Realtime opcional" (ARCHITECTURE.md §2).

import { accountEmail } from '../domain/accounts'
import { BusinessError } from '../mock/engine'
import type { Api, Auth, Commands, Realtime } from './index'

export interface SupabaseConfig {
  url: string
  publishableKey: string
  emailDomain: string
  /** Para pruebas: fetch y almacenamiento propios. */
  fetch?: typeof fetch
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  /** Cada cuánto se vuelven a leer los datos de la pantalla (ms). */
  pollMs?: number
}

interface Session {
  access_token: string
  refresh_token: string
  /** Vencimiento del token de acceso (segundos desde 1970). */
  expires_at: number
  user_id: string
  email: string
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  expires_at?: number
  user: { id: string; email: string }
}

// Una sesión por pestaña, igual que el simulado: cerrar el navegador de una
// computadora compartida termina la sesión.
const SESSION_KEY = 'integrar-erp.supabase.session'
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/** Fechas con hora en el mismo formato que el simulador (toISOString, en UTC). */
export function normalizeTimestamps<V>(value: V): V {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return TIMESTAMP.test(v) ? new Date(v).toISOString() : v
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(value) as V
}

const sessionEnded = () => new BusinessError('SIN_SESION', 'Tu sesión terminó. Volvé a ingresar.')

export function createSupabaseBackend(config: SupabaseConfig) {
  const http: typeof fetch = config.fetch ?? ((input, init) => fetch(input, init))
  const storage = config.storage ?? sessionStorage
  const base = config.url.replace(/\/+$/, '')
  const json = { apikey: config.publishableKey, 'Content-Type': 'application/json' }

  function readSession(): Session | null {
    try {
      const raw = storage.getItem(SESSION_KEY)
      return raw ? (JSON.parse(raw) as Session) : null
    } catch {
      return null
    }
  }

  function writeSession(session: Session | null) {
    try {
      if (session) storage.setItem(SESSION_KEY, JSON.stringify(session))
      else storage.removeItem(SESSION_KEY)
    } catch {
      // Sin almacenamiento: la sesión dura lo que la página.
    }
  }

  const toSession = (t: TokenResponse): Session => ({
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: t.expires_at ?? Math.floor(Date.now() / 1000) + t.expires_in,
    user_id: t.user.id,
    email: t.user.email,
  })

  async function send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await http(`${base}${path}`, init)
    } catch {
      throw new BusinessError('SIN_CONEXION', 'No hay conexión con el servidor. Revisá la red y volvé a intentar.')
    }
  }

  async function body(res: Response) {
    const text = await res.text()
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  async function passwordGrant(email: string, password: string) {
    return send('/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email, password }),
    })
  }

  // Varias consultas pueden encontrar el token vencido a la vez: se renueva una sola vez.
  let refreshing: Promise<Session | null> | null = null
  function refresh(session: Session): Promise<Session | null> {
    refreshing ??= (async () => {
      try {
        const res = await send('/auth/v1/token?grant_type=refresh_token', {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ refresh_token: session.refresh_token }),
        })
        const next = res.ok ? toSession(await res.json()) : null
        writeSession(next)
        return next
      } finally {
        refreshing = null
      }
    })()
    return refreshing
  }

  async function activeSession(): Promise<Session> {
    let session = readSession()
    if (session && session.expires_at - Date.now() / 1000 < 60) session = await refresh(session)
    if (!session) throw sessionEnded()
    return session
  }

  /** Pedido con la sesión del usuario; si el token venció en el camino, se renueva y se reintenta una vez. */
  async function authorized(path: string, init: RequestInit): Promise<Response> {
    let session = await activeSession()
    const go = (s: Session) =>
      send(path, { ...init, headers: { ...json, ...init.headers, Authorization: `Bearer ${s.access_token}` } })
    let res = await go(session)
    if (res.status === 401) {
      const renewed = await refresh(session)
      if (!renewed) throw sessionEnded()
      session = renewed
      res = await go(session)
    }
    return res
  }

  function failure(status: number, data: { code?: string; details?: string; message?: string; hint?: string } | null) {
    // Errores de negocio de las RPC: código en "details" (ARCHITECTURE.md §7.4).
    if (data?.code === 'P0001')
      return new BusinessError(data.details || 'ERROR', data.message ?? '', data.hint || undefined)
    if (status === 401) return sessionEnded()
    return new Error(data?.message ?? `El servidor respondió con el error ${status}.`)
  }

  async function rpc<R>(fn: string, args: Record<string, unknown> = {}): Promise<R> {
    const res = await authorized(`/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) })
    const data = await body(res)
    if (!res.ok) {
      const error = failure(res.status, data)
      if (error instanceof BusinessError && (error.code === 'SIN_SESION' || error.code === 'USUARIO_INACTIVO'))
        writeSession(null)
      throw error
    }
    return normalizeTimestamps(data) as R
  }

  /** Edge Function "admin-users": cuentas de Auth (sólo con la clave de servicio, en el servidor). */
  async function accounts<R>(action: string, payload: Record<string, unknown>): Promise<R> {
    const res = await authorized('/functions/v1/admin-users', {
      method: 'POST',
      body: JSON.stringify({ action, ...payload }),
    })
    const data = await body(res)
    if (res.ok) return data as R
    if (data?.code && data?.message) throw new BusinessError(data.code, data.message, data.hint || undefined)
    throw failure(res.status, data)
  }

  const notAvailable = (what: string) => new BusinessError('NO_DISPONIBLE', `${what} sólo existe en la demostración.`)

  // ------------------------------------------------------------ Autenticación

  const auth: Auth = {
    async login(username: string, password: string) {
      const res = await passwordGrant(accountEmail(username, config.emailDomain), password)
      if (!res.ok) {
        if (res.status === 429)
          throw new BusinessError('DEMASIADOS_INTENTOS', 'Demasiados intentos. Esperá un momento y volvé a probar.')
        throw new BusinessError('CREDENCIALES', 'Usuario o contraseña incorrectos.')
      }
      const session = toSession(await res.json())
      writeSession(session)
      // Igual que el simulador: un usuario desactivado no entra (USUARIO_INACTIVO cierra la sesión).
      await rpc('my_context')
      return session.user_id
    },
    async loginAs(_username: string) {
      throw notAvailable('El acceso rápido')
    },
    logout() {
      const session = readSession()
      writeSession(null)
      if (session)
        void send('/auth/v1/logout', {
          method: 'POST',
          headers: { ...json, Authorization: `Bearer ${session.access_token}` },
        }).catch(() => {})
    },
    demoUsers: () => [],
    async schoolInfo() {
      const res = await send('/rest/v1/rpc/public_school_info', { method: 'POST', headers: json, body: '{}' })
      const data = await body(res)
      if (!res.ok) throw failure(res.status, data)
      return data
    },
  }

  // ------------------------------------------------------------ Consultas

  const company = (companyId: string) => ({ p_company_id: companyId })

  const api: Api = {
    me: () => rpc('my_context'),
    companyContext: (slug) => rpc('company_context', { p_slug: slug }),
    customers: (companyId) => rpc('customers_list', company(companyId)),
    suppliers: (companyId) => rpc('suppliers_list', company(companyId)),
    products: (companyId) => rpc('products_list', company(companyId)),
    product: (companyId, code) => rpc('product_detail', { ...company(companyId), p_code: code }),
    stock: (companyId) => rpc('stock_list', company(companyId)),
    documents: (companyId, docType) => rpc('documents_list', { ...company(companyId), p_doc_type: docType }),
    document: (companyId, docType, number) =>
      rpc('document_detail', { ...company(companyId), p_doc_type: docType, p_display_number: number }),
    documentById: (docId) => rpc('document_detail_by_id', { p_document_id: docId }),
    pendingRequisitionLines: (companyId) => rpc('requisition_lines_pending', company(companyId)),
    receivableOrders: (companyId) => rpc('orders_receivable', company(companyId)),
    invoiceableOrders: (companyId) => rpc('orders_invoiceable', company(companyId)),
    salesCustomers: (companyId) => rpc('sales_customers', company(companyId)),
    salesCatalog: (companyId) => rpc('sales_catalog', company(companyId)),
    dispatchableOrders: (companyId) => rpc('orders_dispatchable', company(companyId)),
    invoiceableSalesOrders: (companyId) => rpc('sales_orders_invoiceable', company(companyId)),
    receivables: (companyId) => rpc('receivables_list', company(companyId)),
    customerAccount: (companyId, customerId) =>
      rpc('customer_account', { ...company(companyId), p_customer_id: customerId }),
    payables: (companyId) => rpc('payables_list', company(companyId)),
    supplierAccount: (companyId, supplierId) =>
      rpc('supplier_account', { ...company(companyId), p_supplier_id: supplierId }),
    postingRules: (companyId) => rpc('posting_rules_list', company(companyId)),
    treasuryAccounts: (companyId) => rpc('treasury_accounts', company(companyId)),
    cashFlow: (companyId, from, to) => rpc('cash_flow', { ...company(companyId), p_from: from, p_to: to }),
    cashProjection: (companyId) => rpc('cash_projection', company(companyId)),
    issuedCheques: (companyId) => rpc('issued_cheques', company(companyId)),
    reconciliationCandidates: (companyId, accountId, statementDate) =>
      rpc('reconciliation_candidates', {
        ...company(companyId),
        p_account_id: accountId,
        p_statement_date: statementDate,
      }),
    paymentCandidates: (companyId, supplierId) =>
      rpc('payment_candidates', { ...company(companyId), p_supplier_id: supplierId }),
    receiptCandidates: (companyId, customerId) =>
      rpc('receipt_candidates', { ...company(companyId), p_customer_id: customerId }),
    priceLists: (companyId) => rpc('price_lists_list', company(companyId)),
    priceList: (companyId, code) => rpc('price_list_detail', { ...company(companyId), p_code: code }),
    accounts: (companyId) => rpc('accounts_list', company(companyId)),
    fiscalYears: (companyId) => rpc('fiscal_years_list', company(companyId)),
    journalBook: (companyId, from, to) => rpc('journal_book', { ...company(companyId), p_from: from, p_to: to }),
    ledger: (companyId, accountId, from, to) =>
      rpc('ledger', { ...company(companyId), p_account_id: accountId, p_from: from, p_to: to }),
    trialBalance: (companyId, from, to) => rpc('trial_balance', { ...company(companyId), p_from: from, p_to: to }),
    tasks: (companyId, scope, includeClosed = false) =>
      rpc('tasks_list', { ...company(companyId), p_scope: scope, p_include_closed: includeClosed }),
    notifications: (companyId, limit = 60) => rpc('notifications_list', { ...company(companyId), p_limit: limit }),
    audit: (companyId) => rpc('audit_list', company(companyId)),
    dashboard: (companyId) => rpc('dashboard', company(companyId)),
    members: (companyId) => rpc('members_list', company(companyId)),
    users: () => rpc('users_list'),
    courses: () => rpc('courses_list'),
    teachers: () => rpc('teachers_list'),

    exportCustomers: (companyId) => rpc('export_rows', { ...company(companyId), p_kind: 'customers' }),
    exportSuppliers: (companyId) => rpc('export_rows', { ...company(companyId), p_kind: 'suppliers' }),
    exportProducts: (companyId) => rpc('export_rows', { ...company(companyId), p_kind: 'products' }),
    exportStock: (companyId) => rpc('export_rows', { ...company(companyId), p_kind: 'stock' }),
    exportAudit: (companyId) => rpc('export_rows', { ...company(companyId), p_kind: 'audit' }),
  }

  // ------------------------------------------------------------ Comandos

  const doc = (docId: string) => ({ p_document_id: docId })

  const commands: Commands = {
    createRequisition: (companyId, input, submit) =>
      rpc('pr_create', { ...company(companyId), p_input: input, p_submit: submit }),
    updateRequisition: (docId, input) => rpc('pr_update', { ...doc(docId), p_input: input }),
    submitRequisition: (docId) => rpc('pr_submit', doc(docId)),
    rejectRequisition: (docId, reason) => rpc('pr_reject', { ...doc(docId), p_reason: reason }),
    cancelRequisition: (docId, reason) => rpc('pr_cancel', { ...doc(docId), p_reason: reason }),
    closeRequisition: (docId, reason) => rpc('pr_close', { ...doc(docId), p_reason: reason }),

    createPurchaseOrder: (companyId, input) => rpc('po_create', { ...company(companyId), p_input: input }),
    updatePurchaseOrder: (docId, input) => rpc('po_update', { ...doc(docId), p_input: input }),
    submitPurchaseOrder: (docId) => rpc('po_submit', doc(docId)),
    approvePurchaseOrder: (docId, comment) => rpc('po_approve', { ...doc(docId), p_comment: comment }),
    rejectPurchaseOrder: (docId, reason) => rpc('po_reject', { ...doc(docId), p_reason: reason }),
    withdrawPurchaseOrder: (docId) => rpc('po_withdraw', doc(docId)),
    reopenPurchaseOrder: (docId) => rpc('po_reopen', doc(docId)),
    sendPurchaseOrder: (docId) => rpc('po_send', doc(docId)),
    cancelPurchaseOrder: (docId, reason) => rpc('po_cancel', { ...doc(docId), p_reason: reason }),
    closePurchaseOrder: (docId, reason) => rpc('po_close', { ...doc(docId), p_reason: reason }),

    createGoodsReceipt: (companyId, input, confirm) =>
      rpc('gr_create', { ...company(companyId), p_input: input, p_confirm: confirm }),
    confirmGoodsReceipt: (docId) => rpc('gr_confirm', doc(docId)),
    cancelGoodsReceipt: (docId, reason) => rpc('gr_cancel', { ...doc(docId), p_reason: reason }),

    createStockAdjustment: (companyId, input, confirm) =>
      rpc('sa_create', { ...company(companyId), p_input: input, p_confirm: confirm }),
    confirmStockAdjustment: (docId) => rpc('sa_confirm', doc(docId)),
    cancelStockAdjustment: (docId, reason) => rpc('sa_cancel', { ...doc(docId), p_reason: reason }),

    createSupplierInvoice: (companyId, input, register) =>
      rpc('si_create', { ...company(companyId), p_input: input, p_register: register }),
    confirmSupplierInvoice: (docId) => rpc('si_confirm', doc(docId)),
    cancelSupplierInvoice: (docId, reason) => rpc('si_cancel', { ...doc(docId), p_reason: reason }),
    savePostingRule: (companyId, ruleId, accountId) =>
      rpc('posting_rule_save', { ...company(companyId), p_rule_id: ruleId, p_account_id: accountId }),

    createPaymentOrder: (companyId, input, submit) =>
      rpc('op_create', { ...company(companyId), p_input: input, p_submit: submit }),
    submitPaymentOrder: (docId) => rpc('op_submit', doc(docId)),
    approvePaymentOrder: (docId, comment) => rpc('op_approve', { ...doc(docId), p_comment: comment }),
    rejectPaymentOrder: (docId, reason) => rpc('op_reject', { ...doc(docId), p_reason: reason }),
    payPaymentOrder: (docId, reference, method) =>
      rpc('op_pay', { ...doc(docId), p_reference: reference, p_method: method }),
    cancelPaymentOrder: (docId, reason) => rpc('op_cancel', { ...doc(docId), p_reason: reason }),
    createRfq: (companyId, input, send) => rpc('rfq_create', { ...company(companyId), p_input: input, p_send: send }),
    sendRfq: (docId) => rpc('rfq_submit', doc(docId)),
    cancelRfq: (docId, reason) => rpc('rfq_cancel', { ...doc(docId), p_reason: reason }),
    awardRfq: (docId, quoteId, reason) => rpc('rfq_award', { ...doc(docId), p_quote_id: quoteId, p_reason: reason }),
    createSupplierQuote: (companyId, input) => rpc('sq_create', { ...company(companyId), p_input: input }),
    cancelSupplierQuote: (docId, reason) => rpc('sq_cancel', { ...doc(docId), p_reason: reason }),
    createFundsTransfer: (companyId, input, confirm) =>
      rpc('ft_create', { ...company(companyId), p_input: input, p_confirm: confirm }),
    confirmFundsTransfer: (docId) => rpc('ft_confirm', doc(docId)),
    cancelFundsTransfer: (docId, reason) => rpc('ft_cancel', { ...doc(docId), p_reason: reason }),
    createBankReconciliation: (companyId, input) => rpc('br_create', { ...company(companyId), p_input: input }),
    cancelBankReconciliation: (docId, reason) => rpc('br_cancel', { ...doc(docId), p_reason: reason }),
    createSalesOrder: (companyId, input, confirm) =>
      rpc('so_create', { ...company(companyId), p_input: input, p_confirm: confirm }),
    confirmSalesOrder: (docId) => rpc('so_confirm', doc(docId)),
    approveSalesOrder: (docId, comment) => rpc('so_approve', { ...doc(docId), p_comment: comment }),
    rejectSalesOrder: (docId, reason) => rpc('so_reject', { ...doc(docId), p_reason: reason }),
    cancelSalesOrder: (docId, reason) => rpc('so_cancel', { ...doc(docId), p_reason: reason }),
    closeSalesOrder: (docId, reason) => rpc('so_close', { ...doc(docId), p_reason: reason }),
    createDeliveryNote: (companyId, input, confirm) =>
      rpc('dn_create', { ...company(companyId), p_input: input, p_confirm: confirm }),
    confirmDeliveryNote: (docId) => rpc('dn_confirm', doc(docId)),
    cancelDeliveryNote: (docId, reason) => rpc('dn_cancel', { ...doc(docId), p_reason: reason }),
    createSalesInvoice: (companyId, input, register) =>
      rpc('fv_create', { ...company(companyId), p_input: input, p_register: register }),
    confirmSalesInvoice: (docId) => rpc('fv_confirm', doc(docId)),
    cancelSalesInvoice: (docId, reason) => rpc('fv_cancel', { ...doc(docId), p_reason: reason }),
    createCustomerReceipt: (companyId, input, confirm) =>
      rpc('rc_create', { ...company(companyId), p_input: input, p_confirm: confirm }),
    confirmCustomerReceipt: (docId) => rpc('rc_confirm', doc(docId)),
    cancelCustomerReceipt: (docId, reason) => rpc('rc_cancel', { ...doc(docId), p_reason: reason }),
    createPriceList: (companyId, input) => rpc('pl_create', { ...company(companyId), p_input: input }),
    updatePriceList: (companyId, listId, input) =>
      rpc('pl_update', { ...company(companyId), p_price_list_id: listId, p_input: input }),
    setPriceListActive: (companyId, listId, active) =>
      rpc('pl_set_active', { ...company(companyId), p_price_list_id: listId, p_active: active }),
    setPriceListPrice: (companyId, listId, productId, price) =>
      rpc('pl_set_price', { ...company(companyId), p_price_list_id: listId, p_product_id: productId, p_price: price }),
    adjustPriceList: (companyId, listId, percent) =>
      rpc('pl_adjust', { ...company(companyId), p_price_list_id: listId, p_percent: percent }),
    createSalesQuote: (companyId, input, send) =>
      rpc('pre_create', { ...company(companyId), p_input: input, p_send: send }),
    sendSalesQuote: (docId) => rpc('pre_send', doc(docId)),
    acceptSalesQuote: (docId) => rpc('pre_accept', doc(docId)),
    rejectSalesQuote: (docId, reason) => rpc('pre_reject', { ...doc(docId), p_reason: reason }),
    expireSalesQuote: (docId) => rpc('pre_expire', doc(docId)),
    cancelSalesQuote: (docId, reason) => rpc('pre_cancel', { ...doc(docId), p_reason: reason }),

    createJournalEntry: (companyId, input, confirm) =>
      rpc('je_create', { ...company(companyId), p_input: input, p_confirm: confirm }),
    updateJournalEntry: (docId, input) => rpc('je_update', { ...doc(docId), p_input: input }),
    confirmJournalEntry: (docId) => rpc('je_confirm', doc(docId)),
    cancelJournalEntry: (docId, reason) => rpc('je_cancel', { ...doc(docId), p_reason: reason }),
    saveAccount: (companyId, input) => rpc('account_save', { ...company(companyId), p_input: input }),
    setAccountActive: (companyId, accountId, active) =>
      rpc('account_set_active', { ...company(companyId), p_account_id: accountId, p_active: active }),
    openFiscalYear: (companyId, year) => rpc('fiscal_year_open', { ...company(companyId), p_year: year }),
    setPeriodStatus: (companyId, periodId, status, reason) =>
      rpc('fiscal_period_set_status', {
        ...company(companyId),
        p_period_id: periodId,
        p_status: status,
        p_reason: reason,
      }),

    saveMaster: (kind, companyId, input) => rpc('master_save', { p_kind: kind, ...company(companyId), p_data: input }),
    setMasterActive: (kind, companyId, id, active) =>
      rpc('master_set_active', { p_kind: kind, ...company(companyId), p_id: id, p_active: active }),

    claimTask: (taskId, claim) => rpc('task_claim', { p_task_id: taskId, p_claim: claim }),
    markNotificationsRead: (companyId, ids) =>
      rpc('notifications_mark_read', { ...company(companyId), p_ids: ids === 'all' ? null : ids }),

    assignRole: (companyId, userId, role, sectorId) =>
      rpc('member_assign_role', { ...company(companyId), p_user_id: userId, p_role: role, p_sector_id: sectorId }),
    removeRole: (companyId, memberRoleId) =>
      rpc('member_remove_role', { ...company(companyId), p_member_role_id: memberRoleId }),
    createStudent: async (companyId, input) =>
      (await accounts<{ id: string }>('create_student', { company_id: companyId, ...input })).id,
    createStudentsBulk: (companyId, rows) => accounts('create_students_bulk', { company_id: companyId, rows }),
    resetPassword: async (companyId, userId, newPassword) => {
      await accounts('reset_password', { company_id: companyId, user_id: userId, password: newPassword })
    },
    setModule: (companyId, module, enabled) =>
      rpc('company_set_module', { ...company(companyId), p_module: module, p_enabled: enabled }),
    updateCompanySettings: (companyId, settings) =>
      rpc('company_update_settings', { ...company(companyId), p_settings: settings }),

    // Cambio de la propia contraseña (cmdChangePassword): lo hace Auth con la sesión del usuario.
    async changePassword(input) {
      const session = await activeSession()
      const check = await passwordGrant(session.email, input.current_password)
      if (!check.ok) throw new BusinessError('DATO_INVALIDO', 'La contraseña actual no coincide.')
      // La verificación abre una sesión nueva (recién autenticada): se usa para el cambio.
      writeSession(toSession(await check.json()))
      if (input.new_password.length < 6)
        throw new BusinessError('DATO_INVALIDO', 'La contraseña nueva debe tener al menos 6 caracteres.')
      if (input.new_password === input.current_password)
        throw new BusinessError('DATO_INVALIDO', 'Elegí una contraseña distinta de la actual.')
      const res = await authorized('/auth/v1/user', {
        method: 'PUT',
        body: JSON.stringify({ password: input.new_password }),
      })
      if (!res.ok) {
        const data = await body(res)
        throw new BusinessError('DATO_INVALIDO', data?.msg ?? data?.message ?? 'No se pudo cambiar la contraseña.')
      }
      await rpc('profile_password_changed')
    },
    createTeacher: async (input) => (await accounts<{ id: string }>('create_teacher', { ...input })).id,
    createCourse: (input) =>
      rpc('course_create', {
        p_academic_year: input.academic_year,
        p_name: input.name,
        p_orientation: input.orientation,
      }),
    updateSchoolSettings: (input) => rpc('school_settings_update', { p_settings: input }),
    uploadSchoolLogo: async (file) => {
      const bucket = 'school-logos'
      const path = `logo-${Date.now()}.${file.name.split('.').pop()}`
      const res = await authorized(`/storage/v1/object/${bucket}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type },
        body: Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0)),
      })
      if (!res.ok) {
        const data = await body(res)
        throw new BusinessError('DATO_INVALIDO', data?.message ?? 'No se pudo subir el logo.')
      }
      const logoPath = `${bucket}/${path}`
      await rpc('school_settings_update', { p_settings: { logo_path: logoPath } })
      return { logo_path: logoPath }
    },
    createCompanyFromTemplate: (courseId) => rpc('company_create_from_template', { p_course_id: courseId }),

    async resetDemoData() {
      throw notAvailable('El reinicio de los datos')
    },
  }

  // ------------------------------------------------------------ Actualización

  const realtime: Realtime = {
    subscribe(fn) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
      const tick = () => {
        if (document.visibilityState === 'visible') fn()
      }
      const timer = window.setInterval(tick, config.pollMs ?? 20_000)
      document.addEventListener('visibilitychange', tick)
      return () => {
        window.clearInterval(timer)
        document.removeEventListener('visibilitychange', tick)
      }
    },
  }

  return { auth, api, commands, realtime, currentUserId: () => readSession()?.user_id ?? null }
}
