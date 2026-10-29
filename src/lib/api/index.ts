// Capa de acceso a datos de la interfaz: el único contrato que usan las pantallas.
//
// Dos implementaciones con la misma forma de datos (ver el final del archivo):
// - la demostración: backend simulado del navegador (src/lib/mock), definido acá;
// - Supabase (supabase.ts), con VITE_BACKEND=supabase: funciones SQL que
//   devuelven lo mismo que queries.ts (supabase/tests/reads.test.ts).

import { DEFAULT_AUTH_EMAIL_DOMAIN } from '../domain/accounts'
import type * as T from '../domain/types'
import { onDatabaseChange, read, resetDatabase, transact, type DB } from '../mock/db'
import * as E from '../mock/engine'
import * as Q from '../mock/queries'
import { DEMO_PASSWORD } from '../mock/seed'
import { createSupabaseBackend, type SupabaseConfig } from './supabase'

export { BusinessError } from '../mock/engine'
export type {
  AccountRow,
  AgingKey,
  AvailableAction,
  BomComponentLine,
  BomDetail,
  BomOperationLine,
  BomRow,
  CashFlow,
  CashFlowAccount,
  CashFlowConcept,
  CashProjection,
  CashProjectionBucket,
  ChequeStatus,
  CompanyContext,
  ComparisonQuote,
  CustomerAccount,
  CustomerAccountMovement,
  Dashboard,
  DeliveryView,
  DetailLine,
  DispatchableOrder,
  DocRef,
  DocumentDetail,
  DocumentListItem,
  EmployeeRow,
  FiscalYearView,
  FlowNode,
  InvoiceableOrder,
  InvoiceableSalesOrder,
  IssuedCheque,
  IvaBook,
  IvaBookRow,
  ObligationRow,
  ObligationsCalendar,
  JobCategoryRow,
  LaborAgreementRow,
  JournalBook,
  JournalBookEntry,
  JournalView,
  LaborVariance,
  LaborVarianceRow,
  Ledger,
  LedgerRow,
  MeContext,
  MemberView,
  PayableInvoice,
  PayableRow,
  PaymentCandidate,
  PaymentLineView,
  PaymentView,
  PayrollLineView,
  PayrollView,
  PendingRequisitionLine,
  PeriodView,
  TaxReturnView,
  PostingRuleRow,
  PriceListDetail,
  PriceListProduct,
  PriceListRow,
  ProducibleProduct,
  ProductionCostRow,
  ProductionNeedRow,
  ProductionOrderView,
  ProductDetail,
  ProductRow,
  QuoteView,
  ReceivableOrder,
  ReconciliationCandidates,
  ReconciliationLineView,
  ReconciliationView,
  ReceivableInvoice,
  ReceivableRow,
  ReceiptCandidate,
  ReceiptView,
  RfqView,
  SalesCustomer,
  SalesOrderView,
  SalesQuoteView,
  SellableProduct,
  StockRow,
  SupplierAccount,
  SupplierAccountMovement,
  TaskItem,
  TreasuryAccountRow,
  TransferView,
  TrialBalance,
  TrialBalanceRow,
  WarehouseAvailability,
  WorkCenterRow,
} from '../mock/queries'
export type {
  AccountInput,
  BankReconciliationInput,
  BomInput,
  CustomerReceiptInput,
  ChangePasswordInput,
  CourseInput,
  DeliveryNoteInput,
  FundsTransferInput,
  GoodsReceiptInput,
  JournalEntryInput,
  PaymentOrderInput,
  PriceListInput,
  ProductionIssueInput,
  ProductionOrderInput,
  PurchaseOrderInput,
  RequisitionInput,
  RfqInput,
  SalesInvoiceInput,
  SalesOrderInput,
  SalesQuoteInput,
  SchoolSettingsInput,
  StockAdjustmentInput,
  SupplierInvoiceInput,
  SupplierQuoteInput,
  StudentCredential,
  StudentInput,
  TeacherInput,
  WorkCenterInput,
  MasterKind,
} from '../mock/engine'

const SESSION_KEY = 'integrar-erp.session'

function mockSessionUserId(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
}

/**
 * Exige una sesión con un perfil activo *en este momento*, no sólo al
 * momento de iniciar sesión: si el docente desactiva a un estudiante, la
 * pestaña que ya tenía abierta deja de poder leer o escribir en el próximo
 * pedido, no recién cuando vuelva a ingresar.
 */
function requireActiveUser(db: DB): string {
  const id = mockSessionUserId()
  if (!id) throw new E.BusinessError('SIN_SESION', 'Tu sesión terminó. Volvé a ingresar.')
  const profile = db.profiles.find((p) => p.id === id)
  if (!profile || !profile.is_active) {
    sessionStorage.removeItem(SESSION_KEY)
    throw new E.BusinessError('USUARIO_INACTIVO', 'Tu usuario está desactivado. Consultá a tu docente.')
  }
  return id
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function query<R>(fn: (db: DB, userId: string) => R): Promise<R> {
  await wait(40)
  return read((db) => fn(db, requireActiveUser(db)))
}

async function command<R>(fn: (ctx: E.Ctx) => R): Promise<R> {
  await wait(150)
  return transact((db) => fn({ db, userId: requireActiveUser(db), now: new Date().toISOString() }))
}

// ------------------------------------------------------------ Autenticación

const mockAuth = {
  async login(username: string, password: string) {
    await wait(250)
    const name = username.trim().toLowerCase()
    const profile = read((db) => db.profiles.find((p) => p.username === name))
    if (!profile || profile.password !== password)
      throw new E.BusinessError('CREDENCIALES', 'Usuario o contraseña incorrectos.')
    if (!profile.is_active)
      throw new E.BusinessError('USUARIO_INACTIVO', 'Tu usuario está desactivado. Consultá a tu docente.')
    sessionStorage.setItem(SESSION_KEY, profile.id)
    return profile.id
  },
  /** Acceso rápido de demostración (sólo backend simulado). */
  loginAs(username: string) {
    return mockAuth.login(username, DEMO_PASSWORD)
  },
  logout() {
    sessionStorage.removeItem(SESSION_KEY)
  },
  demoUsers() {
    return read(Q.demoUsers)
  },
  /** Nombre de la escuela para la pantalla de ingreso (no requiere sesión). */
  async schoolInfo() {
    await wait(40)
    return read(Q.publicSchoolInfo)
  },
}

// ------------------------------------------------------------ Consultas

const mockApi = {
  me: () => query(Q.meContext),
  companyContext: (slug: string) => query((db, u) => Q.companyContext(db, u, slug)),
  customers: (companyId: string) => query((db, u) => Q.listCustomers(db, u, companyId)),
  suppliers: (companyId: string) => query((db, u) => Q.listSuppliers(db, u, companyId)),
  products: (companyId: string) => query((db, u) => Q.listProducts(db, u, companyId)),
  product: (companyId: string, code: string) => query((db, u) => Q.productDetail(db, u, companyId, code)),
  stock: (companyId: string) => query((db, u) => Q.listStock(db, u, companyId)),
  documents: (companyId: string, docType: T.DocType) => query((db, u) => Q.listDocuments(db, u, companyId, docType)),
  document: (companyId: string, docType: T.DocType, number: string) =>
    query((db, u) => Q.documentDetail(db, u, companyId, docType, number)),
  documentById: (docId: string) => query((db, u) => Q.documentDetailById(db, u, docId)),
  pendingRequisitionLines: (companyId: string) => query((db, u) => Q.pendingRequisitionLines(db, u, companyId)),
  receivableOrders: (companyId: string) => query((db, u) => Q.receivableOrders(db, u, companyId)),
  invoiceableOrders: (companyId: string) => query((db, u) => Q.invoiceableOrders(db, u, companyId)),
  salesCustomers: (companyId: string) => query((db, u) => Q.salesCustomers(db, u, companyId)),
  salesCatalog: (companyId: string) => query((db, u) => Q.salesCatalog(db, u, companyId)),
  dispatchableOrders: (companyId: string) => query((db, u) => Q.dispatchableOrders(db, u, companyId)),
  invoiceableSalesOrders: (companyId: string) => query((db, u) => Q.invoiceableSalesOrders(db, u, companyId)),
  receivables: (companyId: string) => query((db, u) => Q.listReceivables(db, u, companyId)),
  customerAccount: (companyId: string, customerId: string) =>
    query((db, u) => Q.customerAccount(db, u, companyId, customerId)),
  payables: (companyId: string) => query((db, u) => Q.listPayables(db, u, companyId)),
  supplierAccount: (companyId: string, supplierId: string) =>
    query((db, u) => Q.supplierAccount(db, u, companyId, supplierId)),
  postingRules: (companyId: string) => query((db, u) => Q.listPostingRules(db, u, companyId)),
  treasuryAccounts: (companyId: string) => query((db, u) => Q.treasuryAccounts(db, u, companyId)),
  cashFlow: (companyId: string, from: string, to: string) => query((db, u) => Q.cashFlow(db, u, companyId, from, to)),
  cashProjection: (companyId: string) => query((db, u) => Q.cashProjection(db, u, companyId)),
  issuedCheques: (companyId: string) => query((db, u) => Q.issuedCheques(db, u, companyId)),
  reconciliationCandidates: (companyId: string, accountId: string, statementDate: string) =>
    query((db, u) => Q.reconciliationCandidates(db, u, companyId, accountId, statementDate)),
  paymentCandidates: (companyId: string, supplierId: string) =>
    query((db, u) => Q.paymentCandidates(db, u, companyId, supplierId)),
  receiptCandidates: (companyId: string, customerId: string) =>
    query((db, u) => Q.receiptCandidates(db, u, companyId, customerId)),
  priceLists: (companyId: string) => query((db, u) => Q.listPriceLists(db, u, companyId)),
  priceList: (companyId: string, code: string) => query((db, u) => Q.priceListDetail(db, u, companyId, code)),
  boms: (companyId: string) => query((db, u) => Q.listBoms(db, u, companyId)),
  bom: (companyId: string, productCode: string) => query((db, u) => Q.bomDetail(db, u, companyId, productCode)),
  productionCatalog: (companyId: string) => query((db, u) => Q.productionCatalog(db, u, companyId)),
  workCenters: (companyId: string) => query((db, u) => Q.listWorkCenters(db, u, companyId)),
  productionCosts: (companyId: string, from: string, to: string) =>
    query((db, u) => Q.productionCosts(db, u, companyId, from, to)),
  laborAgreements: (companyId: string) => query((db, u) => Q.listLaborAgreements(db, u, companyId)),
  jobCategories: (companyId: string) => query((db, u) => Q.listJobCategories(db, u, companyId)),
  employees: (companyId: string) => query((db, u) => Q.listEmployees(db, u, companyId)),
  /** El libro IVA ventas (sales) o compras de un mes (aaaa-mm). */
  obligations: (companyId: string, period: string) => query((db, u) => Q.obligationsCalendar(db, u, companyId, period)),
  ivaBook: (companyId: string, period: string, sales: boolean) =>
    query((db, u) => Q.ivaBook(db, u, companyId, period, sales)),
  /** La mano de obra del taller de un mes (aaaa-mm), por centro: la aplicada contra la real. */
  laborVariance: (companyId: string, period: string) => query((db, u) => Q.laborVariance(db, u, companyId, period)),
  /** Las necesidades de materiales de las órdenes planificadas (todas, o las indicadas). */
  productionNeeds: (companyId: string, documentIds: string[] | null = null) =>
    query((db, u) => Q.productionNeedsView(db, u, companyId, documentIds)),
  accounts: (companyId: string) => query((db, u) => Q.listAccounts(db, u, companyId)),
  fiscalYears: (companyId: string) => query((db, u) => Q.listFiscalYears(db, u, companyId)),
  journalBook: (companyId: string, from: string, to: string) =>
    query((db, u) => Q.journalBook(db, u, companyId, from, to)),
  ledger: (companyId: string, accountId: string, from: string, to: string) =>
    query((db, u) => Q.ledger(db, u, companyId, accountId, from, to)),
  trialBalance: (companyId: string, from: string, to: string) =>
    query((db, u) => Q.trialBalance(db, u, companyId, from, to)),
  tasks: (companyId: string, scope: 'mine' | 'all', includeClosed = false) =>
    query((db, u) => Q.listTasks(db, u, companyId, scope, includeClosed)),
  notifications: (companyId: string, limit: number | null = 60) =>
    query((db, u) => Q.listNotifications(db, u, companyId, limit)),
  audit: (companyId: string) => query((db, u) => Q.listAudit(db, u, companyId)),
  dashboard: (companyId: string) => query((db, u) => Q.dashboard(db, u, companyId)),
  members: (companyId: string) => query((db, u) => Q.listMembers(db, u, companyId)),
  users: () => query(Q.listUsers),
  courses: () => query((db, u) => Q.listCourses(db, u)),
  teachers: () => query((db, u) => Q.listTeachers(db, u)),

  // Exportaciones: validan el permiso `*.export`, no sólo el de lectura.
  exportCustomers: (companyId: string) => query((db, u) => Q.exportCustomers(db, u, companyId)),
  exportSuppliers: (companyId: string) => query((db, u) => Q.exportSuppliers(db, u, companyId)),
  exportProducts: (companyId: string) => query((db, u) => Q.exportProducts(db, u, companyId)),
  exportStock: (companyId: string) => query((db, u) => Q.exportStock(db, u, companyId)),
  exportAudit: (companyId: string) => query((db, u) => Q.exportAudit(db, u, companyId)),
}

// ------------------------------------------------------------ Comandos (futuras RPC)

const mockCommands = {
  createRequisition: (companyId: string, input: E.RequisitionInput, submit: boolean) =>
    command((c) => E.cmdCreateRequisition(c, companyId, input, submit)),
  updateRequisition: (docId: string, input: E.RequisitionInput) =>
    command((c) => E.cmdUpdateRequisition(c, docId, input)),
  submitRequisition: (docId: string) => command((c) => E.cmdSubmitRequisition(c, docId)),
  rejectRequisition: (docId: string, reason: string) => command((c) => E.cmdRejectRequisition(c, docId, reason)),
  cancelRequisition: (docId: string, reason: string) => command((c) => E.cmdCancelRequisition(c, docId, reason)),
  closeRequisition: (docId: string, reason: string) => command((c) => E.cmdCloseRequisition(c, docId, reason)),

  createPurchaseOrder: (companyId: string, input: E.PurchaseOrderInput) =>
    command((c) => E.cmdCreatePurchaseOrder(c, companyId, input)),
  updatePurchaseOrder: (docId: string, input: E.PurchaseOrderInput) =>
    command((c) => E.cmdUpdatePurchaseOrder(c, docId, input)),
  submitPurchaseOrder: (docId: string) => command((c) => E.cmdSubmitPurchaseOrder(c, docId)),
  approvePurchaseOrder: (docId: string, comment: string) =>
    command((c) => E.cmdApprovePurchaseOrder(c, docId, comment)),
  rejectPurchaseOrder: (docId: string, reason: string) => command((c) => E.cmdRejectPurchaseOrder(c, docId, reason)),
  withdrawPurchaseOrder: (docId: string) => command((c) => E.cmdWithdrawPurchaseOrder(c, docId)),
  reopenPurchaseOrder: (docId: string) => command((c) => E.cmdReopenPurchaseOrder(c, docId)),
  sendPurchaseOrder: (docId: string) => command((c) => E.cmdSendPurchaseOrder(c, docId)),
  cancelPurchaseOrder: (docId: string, reason: string) => command((c) => E.cmdCancelPurchaseOrder(c, docId, reason)),
  closePurchaseOrder: (docId: string, reason: string) => command((c) => E.cmdClosePurchaseOrder(c, docId, reason)),

  createGoodsReceipt: (companyId: string, input: E.GoodsReceiptInput, confirm: boolean) =>
    command((c) => E.cmdCreateGoodsReceipt(c, companyId, input, confirm)),
  confirmGoodsReceipt: (docId: string) => command((c) => E.cmdConfirmGoodsReceipt(c, docId)),
  cancelGoodsReceipt: (docId: string, reason: string) => command((c) => E.cmdCancelGoodsReceipt(c, docId, reason)),

  createStockAdjustment: (companyId: string, input: E.StockAdjustmentInput, confirm: boolean) =>
    command((c) => E.cmdCreateStockAdjustment(c, companyId, input, confirm)),
  confirmStockAdjustment: (docId: string) => command((c) => E.cmdConfirmStockAdjustment(c, docId)),
  cancelStockAdjustment: (docId: string, reason: string) =>
    command((c) => E.cmdCancelStockAdjustment(c, docId, reason)),

  createSupplierInvoice: (companyId: string, input: E.SupplierInvoiceInput, register: boolean) =>
    command((c) => E.cmdCreateSupplierInvoice(c, companyId, input, register)),
  confirmSupplierInvoice: (docId: string) => command((c) => E.cmdConfirmSupplierInvoice(c, docId)),
  cancelSupplierInvoice: (docId: string, reason: string) =>
    command((c) => E.cmdCancelSupplierInvoice(c, docId, reason)),
  savePostingRule: (companyId: string, ruleId: string, accountId: string) =>
    command((c) => E.cmdSavePostingRule(c, companyId, ruleId, accountId)),

  createPaymentOrder: (companyId: string, input: E.PaymentOrderInput, submit: boolean) =>
    command((c) => E.cmdCreatePaymentOrder(c, companyId, input, submit)),
  submitPaymentOrder: (docId: string) => command((c) => E.cmdSubmitPaymentOrder(c, docId)),
  approvePaymentOrder: (docId: string, comment: string) => command((c) => E.cmdApprovePaymentOrder(c, docId, comment)),
  rejectPaymentOrder: (docId: string, reason: string) => command((c) => E.cmdRejectPaymentOrder(c, docId, reason)),
  payPaymentOrder: (docId: string, reference: string, method: T.PaymentMethod) =>
    command((c) => E.cmdPayPaymentOrder(c, docId, reference, method)),
  cancelPaymentOrder: (docId: string, reason: string) => command((c) => E.cmdCancelPaymentOrder(c, docId, reason)),
  createRfq: (companyId: string, input: E.RfqInput, send: boolean) =>
    command((c) => E.cmdCreateRfq(c, companyId, input, send)),
  sendRfq: (docId: string) => command((c) => E.cmdSendRfq(c, docId)),
  cancelRfq: (docId: string, reason: string) => command((c) => E.cmdCancelRfq(c, docId, reason)),
  awardRfq: (docId: string, quoteId: string, reason: string) =>
    command((c) => E.cmdAwardRfq(c, docId, quoteId, reason)),
  createSupplierQuote: (companyId: string, input: E.SupplierQuoteInput) =>
    command((c) => E.cmdCreateSupplierQuote(c, companyId, input)),
  cancelSupplierQuote: (docId: string, reason: string) => command((c) => E.cmdCancelSupplierQuote(c, docId, reason)),
  createFundsTransfer: (companyId: string, input: E.FundsTransferInput, confirm: boolean) =>
    command((c) => E.cmdCreateFundsTransfer(c, companyId, input, confirm)),
  confirmFundsTransfer: (docId: string) => command((c) => E.cmdConfirmFundsTransfer(c, docId)),
  cancelFundsTransfer: (docId: string, reason: string) => command((c) => E.cmdCancelFundsTransfer(c, docId, reason)),
  createBankReconciliation: (companyId: string, input: E.BankReconciliationInput) =>
    command((c) => E.cmdCreateBankReconciliation(c, companyId, input)),
  cancelBankReconciliation: (docId: string, reason: string) =>
    command((c) => E.cmdCancelBankReconciliation(c, docId, reason)),
  createSalesOrder: (companyId: string, input: E.SalesOrderInput, confirm: boolean) =>
    command((c) => E.cmdCreateSalesOrder(c, companyId, input, confirm)),
  confirmSalesOrder: (docId: string) => command((c) => E.cmdConfirmSalesOrder(c, docId)),
  approveSalesOrder: (docId: string, comment: string) => command((c) => E.cmdApproveSalesOrder(c, docId, comment)),
  rejectSalesOrder: (docId: string, reason: string) => command((c) => E.cmdRejectSalesOrder(c, docId, reason)),
  cancelSalesOrder: (docId: string, reason: string) => command((c) => E.cmdCancelSalesOrder(c, docId, reason)),
  closeSalesOrder: (docId: string, reason: string) => command((c) => E.cmdCloseSalesOrder(c, docId, reason)),
  createDeliveryNote: (companyId: string, input: E.DeliveryNoteInput, confirm: boolean) =>
    command((c) => E.cmdCreateDeliveryNote(c, companyId, input, confirm)),
  confirmDeliveryNote: (docId: string) => command((c) => E.cmdConfirmDeliveryNote(c, docId)),
  cancelDeliveryNote: (docId: string, reason: string) => command((c) => E.cmdCancelDeliveryNote(c, docId, reason)),
  createSalesInvoice: (companyId: string, input: E.SalesInvoiceInput, register: boolean) =>
    command((c) => E.cmdCreateSalesInvoice(c, companyId, input, register)),
  confirmSalesInvoice: (docId: string) => command((c) => E.cmdConfirmSalesInvoice(c, docId)),
  cancelSalesInvoice: (docId: string, reason: string) => command((c) => E.cmdCancelSalesInvoice(c, docId, reason)),
  createCustomerReceipt: (companyId: string, input: E.CustomerReceiptInput, confirm: boolean) =>
    command((c) => E.cmdCreateCustomerReceipt(c, companyId, input, confirm)),
  confirmCustomerReceipt: (docId: string) => command((c) => E.cmdConfirmCustomerReceipt(c, docId)),
  cancelCustomerReceipt: (docId: string, reason: string) =>
    command((c) => E.cmdCancelCustomerReceipt(c, docId, reason)),
  createPriceList: (companyId: string, input: E.PriceListInput) =>
    command((c) => E.cmdCreatePriceList(c, companyId, input)),
  updatePriceList: (companyId: string, listId: string, input: { name: string; description: string }) =>
    command((c) => E.cmdUpdatePriceList(c, companyId, listId, input)),
  setPriceListActive: (companyId: string, listId: string, active: boolean) =>
    command((c) => E.cmdSetPriceListActive(c, companyId, listId, active)),
  setPriceListPrice: (companyId: string, listId: string, productId: string, price: number | null) =>
    command((c) => E.cmdSetPriceListPrice(c, companyId, listId, productId, price)),
  adjustPriceList: (companyId: string, listId: string, percent: number) =>
    command((c) => E.cmdAdjustPriceList(c, companyId, listId, percent)),
  createSalesQuote: (companyId: string, input: E.SalesQuoteInput, send: boolean) =>
    command((c) => E.cmdCreateSalesQuote(c, companyId, input, send)),
  sendSalesQuote: (docId: string) => command((c) => E.cmdSendSalesQuote(c, docId)),
  acceptSalesQuote: (docId: string) => command((c) => E.cmdAcceptSalesQuote(c, docId)),
  rejectSalesQuote: (docId: string, reason: string) => command((c) => E.cmdRejectSalesQuote(c, docId, reason)),
  expireSalesQuote: (docId: string) => command((c) => E.cmdExpireSalesQuote(c, docId)),
  cancelSalesQuote: (docId: string, reason: string) => command((c) => E.cmdCancelSalesQuote(c, docId, reason)),
  saveBom: (companyId: string, input: E.BomInput) => command((c) => E.cmdSaveBom(c, companyId, input)),
  setBomActive: (companyId: string, bomId: string, active: boolean) =>
    command((c) => E.cmdSetBomActive(c, companyId, bomId, active)),
  createProductionOrder: (companyId: string, input: E.ProductionOrderInput, release: boolean) =>
    command((c) => E.cmdCreateProductionOrder(c, companyId, input, release)),
  releaseProductionOrder: (docId: string) => command((c) => E.cmdReleaseProductionOrder(c, docId)),
  issueProductionOrder: (docId: string, input: E.ProductionIssueInput) =>
    command((c) => E.cmdIssueProductionOrder(c, docId, input)),
  finishProductionOrder: (docId: string, quantity: number, hours: { operation_id: string; hours: number }[] = []) =>
    command((c) => E.cmdFinishProductionOrder(c, docId, quantity, hours)),
  saveWorkCenter: (companyId: string, input: E.WorkCenterInput) =>
    command((c) => E.cmdSaveWorkCenter(c, companyId, input)),
  setWorkCenterActive: (companyId: string, centerId: string, active: boolean) =>
    command((c) => E.cmdSetWorkCenterActive(c, companyId, centerId, active)),
  cancelProductionOrder: (docId: string, reason: string) =>
    command((c) => E.cmdCancelProductionOrder(c, docId, reason)),
  requestProductionMaterials: (companyId: string, documentIds: string[]) =>
    command((c) => E.cmdRequestProductionMaterials(c, companyId, documentIds)),

  saveLaborAgreement: (companyId: string, input: E.LaborAgreementInput) =>
    command((c) => E.cmdSaveLaborAgreement(c, companyId, input)),
  setLaborAgreementActive: (companyId: string, agreementId: string, active: boolean) =>
    command((c) => E.cmdSetLaborAgreementActive(c, companyId, agreementId, active)),
  saveJobCategory: (companyId: string, input: E.JobCategoryInput) =>
    command((c) => E.cmdSaveJobCategory(c, companyId, input)),
  setJobCategoryActive: (companyId: string, categoryId: string, active: boolean) =>
    command((c) => E.cmdSetJobCategoryActive(c, companyId, categoryId, active)),
  saveEmployee: (companyId: string, input: E.EmployeeInput) => command((c) => E.cmdSaveEmployee(c, companyId, input)),
  terminateEmployee: (companyId: string, employeeId: string, date: string, reason: string) =>
    command((c) => E.cmdTerminateEmployee(c, companyId, employeeId, date, reason)),
  createPayroll: (companyId: string, input: E.PayrollInput) => command((c) => E.cmdCreatePayroll(c, companyId, input)),
  updatePayrollLines: (docId: string, lines: E.PayrollLineInput[]) =>
    command((c) => E.cmdUpdatePayrollLines(c, docId, lines)),
  submitPayroll: (docId: string) => command((c) => E.cmdSubmitPayroll(c, docId)),
  approvePayroll: (docId: string, comment: string) => command((c) => E.cmdApprovePayroll(c, docId, comment)),
  rejectPayroll: (docId: string, reason: string) => command((c) => E.cmdRejectPayroll(c, docId, reason)),
  cancelPayroll: (docId: string, reason: string) => command((c) => E.cmdCancelPayroll(c, docId, reason)),
  payPayrollSalaries: (docId: string, accountId: string) =>
    command((c) => E.cmdPayPayrollSalaries(c, docId, accountId)),
  payPayrollCharges: (docId: string, accountId: string) => command((c) => E.cmdPayPayrollCharges(c, docId, accountId)),
  createTaxReturn: (companyId: string, input: E.TaxReturnInput) =>
    command((c) => E.cmdCreateTaxReturn(c, companyId, input)),
  presentTaxReturn: (docId: string) => command((c) => E.cmdPresentTaxReturn(c, docId)),
  payTaxReturn: (docId: string, accountId: string) => command((c) => E.cmdPayTaxReturn(c, docId, accountId)),
  cancelTaxReturn: (docId: string, reason: string) => command((c) => E.cmdCancelTaxReturn(c, docId, reason)),

  createJournalEntry: (companyId: string, input: E.JournalEntryInput, confirm: boolean) =>
    command((c) => E.cmdCreateJournalEntry(c, companyId, input, confirm)),
  updateJournalEntry: (docId: string, input: E.JournalEntryInput) =>
    command((c) => E.cmdUpdateJournalEntry(c, docId, input)),
  confirmJournalEntry: (docId: string) => command((c) => E.cmdConfirmJournalEntry(c, docId)),
  cancelJournalEntry: (docId: string, reason: string) => command((c) => E.cmdCancelJournalEntry(c, docId, reason)),
  saveAccount: (companyId: string, input: E.AccountInput & { id?: string }) =>
    command((c) => E.cmdSaveAccount(c, companyId, input)),
  setAccountActive: (companyId: string, accountId: string, active: boolean) =>
    command((c) => E.cmdSetAccountActive(c, companyId, accountId, active)),
  openFiscalYear: (companyId: string, year: number) => command((c) => E.cmdOpenFiscalYear(c, companyId, year)),
  setPeriodStatus: (companyId: string, periodId: string, status: 'ABIERTO' | 'CERRADO', reason: string) =>
    command((c) => E.cmdSetPeriodStatus(c, companyId, periodId, status, reason)),

  saveMaster: (kind: E.MasterKind, companyId: string, input: Record<string, unknown> & { id?: string }) =>
    command((c) => E.cmdSaveMaster(c, kind, companyId, input)),
  setMasterActive: (kind: E.MasterKind, companyId: string, id: string, active: boolean) =>
    command((c) => E.cmdSetMasterActive(c, kind, companyId, id, active)),

  claimTask: (taskId: string, claim: boolean) => command((c) => E.cmdClaimTask(c, taskId, claim)),
  markNotificationsRead: (companyId: string, ids: string[] | 'all') =>
    command((c) => E.cmdMarkNotificationsRead(c, ids, companyId)),

  assignRole: (companyId: string, userId: string, role: T.RoleCode, sectorId: string | null) =>
    command((c) => E.cmdAssignRole(c, companyId, userId, role, sectorId)),
  removeRole: (companyId: string, memberRoleId: string) => command((c) => E.cmdRemoveRole(c, companyId, memberRoleId)),
  createStudent: (companyId: string, input: E.StudentInput) => command((c) => E.cmdCreateStudent(c, companyId, input)),
  createStudentsBulk: (companyId: string, rows: { first_name: string; last_name: string }[]) =>
    command((c) => E.cmdCreateStudentsBulk(c, companyId, rows)),
  resetPassword: (companyId: string, userId: string, newPassword: string) =>
    command((c) => E.cmdResetPassword(c, companyId, userId, newPassword)),
  setModule: (companyId: string, module: T.ModuleCode, enabled: boolean) =>
    command((c) => E.cmdSetModule(c, companyId, module, enabled)),
  updateCompanySettings: (companyId: string, settings: Partial<T.CompanySettings>) =>
    command((c) => E.cmdUpdateCompanySettings(c, companyId, settings)),

  changePassword: (input: E.ChangePasswordInput) => command((c) => E.cmdChangePassword(c, input)),
  createTeacher: (input: E.TeacherInput) => command((c) => E.cmdCreateTeacher(c, input)),
  createCourse: (input: E.CourseInput) => command((c) => E.cmdCreateCourse(c, input)),
  updateSchoolSettings: (input: E.SchoolSettingsInput) => command((c) => E.cmdUpdateSchoolSettings(c, input)),
  uploadSchoolLogo: (file: { name: string; type: string; data: string }) =>
    command((c) => E.cmdUploadSchoolLogo(c, file)),
  createCompanyFromTemplate: (courseId: string) =>
    command((c) => E.cmdCreateCompanyFromTemplate(c, { course_id: courseId })),

  async resetDemoData() {
    await wait(300)
    read((db) => E.authorizeDemoReset({ db, userId: requireActiveUser(db), now: new Date().toISOString() }))
    resetDatabase()
  },
}

/** Suscripción a cambios: en la demostración, los de otras pestañas del navegador. */
const mockRealtime = { subscribe: onDatabaseChange }

// ------------------------------------------------------------ Backend elegido

export type Auth = typeof mockAuth
export type Api = typeof mockApi
export type Commands = typeof mockCommands
export type Realtime = typeof mockRealtime

/**
 * Con VITE_BACKEND=supabase la aplicación usa Supabase (supabase.ts); si no,
 * el backend simulado del navegador, que es la demostración pública.
 */
function supabaseConfig(): SupabaseConfig {
  const { VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: key, VITE_AUTH_EMAIL_DOMAIN: domain } = import.meta.env
  if (!url || !key) throw new Error('Para usar Supabase faltan VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY.')
  return { url, publishableKey: key, emailDomain: domain || DEFAULT_AUTH_EMAIL_DOMAIN }
}

const real = import.meta.env.VITE_BACKEND === 'supabase' ? createSupabaseBackend(supabaseConfig()) : null

/** true en la demostración (datos en el navegador, accesos rápidos y reinicio de datos). */
export const isDemo = !real
export const currentUserId: () => string | null = real?.currentUserId ?? mockSessionUserId
export const auth: Auth = real?.auth ?? mockAuth
export const api: Api = real?.api ?? mockApi
export const commands: Commands = real?.commands ?? mockCommands
export const realtime: Realtime = real?.realtime ?? mockRealtime
