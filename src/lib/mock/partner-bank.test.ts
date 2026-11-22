import { describe, expect, it } from 'vitest'
import { cmdSaveMaster, type Ctx } from './engine'
import { BANK_CUSTOMERS, BANK_SUPPLIERS } from './partner-bank'
import { buildSeed } from './seed'

/** Dígito verificador oficial del CUIT (11 vale 0; 10 no es válido). */
function cuitIsValid(cuit: string) {
  const digits = cuit.replaceAll('-', '')
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const dv = 11 - (weights.reduce((sum, w, i) => sum + w * Number(digits[i]), 0) % 11)
  return dv !== 10 && Number(digits[10]) === (dv === 11 ? 0 : dv)
}

const bank = [...BANK_SUPPLIERS, ...BANK_CUSTOMERS]

describe('banco de proveedores y clientes ficticios', () => {
  it('usa CUIT del rango simulado, válidos y coherentes con la condición frente al IVA', () => {
    for (const p of bank) {
      if (p.vat_condition === 'CONSUMIDOR_FINAL') {
        expect(p.tax_id).toBe('')
        continue
      }
      expect(p.tax_id).toMatch(/^\d{2}-00000\d{3}-\d$/)
      expect(cuitIsValid(p.tax_id), p.tax_id).toBe(true)
      expect(p.vat_condition === 'MONOTRIBUTO' ? ['20', '23', '27'] : ['30', '33']).toContain(p.tax_id.slice(0, 2))
    }
  })

  it('no repite códigos, razones sociales ni CUIT, tampoco con los propios de la empresa plantilla', () => {
    const seed = buildSeed()
    const codes = new Set(bank.map((p) => p.code))
    // Los que la plantilla trae del banco (la empresa que crece, Fase 9b.1) son los mismos, sin cambios.
    const fromBank = [...seed.suppliers, ...seed.customers].filter((p) => codes.has(p.code))
    expect(fromBank).toHaveLength(40)
    for (const p of fromBank) expect(p).toMatchObject(bank.find((b) => b.code === p.code)!)
    const own = [...seed.suppliers, ...seed.customers].filter((p) => !codes.has(p.code))
    expect(own).toHaveLength(20)
    for (const field of ['code', 'legal_name', 'tax_id'] as const) {
      const values = bank.map((p) => p[field]).filter(Boolean)
      expect(new Set(values).size, field).toBe(values.length)
      expect(
        own.filter((p) => values.includes(p[field])),
        field,
      ).toEqual([])
    }
  })

  it('se carga completo con el alta de maestros', () => {
    const db = buildSeed()
    const companyId = db.companies[0].id
    const ctx = (username: string): Ctx => ({
      db,
      userId: db.profiles.find((p) => p.username === username)!.id,
      now: new Date().toISOString(),
    })
    // Los que la plantilla todavía no trae (la 9b.1 suma diez proveedores y todos los clientes).
    const has = (rows: { company_id: string; code: string }[], code: string) =>
      rows.some((r) => r.company_id === companyId && r.code === code)
    const missing = BANK_SUPPLIERS.filter((s) => !has(db.suppliers, s.code))
    expect(missing).toHaveLength(20)
    for (const s of missing) cmdSaveMaster(ctx('compras1'), 'supplier', companyId, { ...s })
    for (const c of BANK_CUSTOMERS.filter((x) => !has(db.customers, x.code)))
      cmdSaveMaster(ctx('ventas'), 'customer', companyId, { ...c })
    expect(db.suppliers.filter((s) => s.code.startsWith('PRV-1'))).toHaveLength(BANK_SUPPLIERS.length)
    expect(db.customers.filter((c) => c.code.startsWith('CLI-1'))).toHaveLength(BANK_CUSTOMERS.length)
  })
})
