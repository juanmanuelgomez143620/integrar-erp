import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const KEY = 'integrar-erp.mockdb'
let values: Map<string, string>
let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> }
let db: typeof import('./db')

beforeEach(async () => {
  vi.resetModules()
  values = new Map()
  storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
  }
  vi.stubGlobal('localStorage', storage)
  db = await import('./db')
})

afterEach(() => vi.unstubAllGlobals())

describe('persistencia de las operaciones', () => {
  it('conserva cambios de distintos comandos y los recupera después de recargar', async () => {
    db.transact((draft) => {
      draft.school.city = 'Ciudad de prueba'
    })
    db.transact((draft) => {
      draft.school.province = 'Provincia de prueba'
    })
    vi.resetModules()
    const reloaded = await import('./db')
    expect(reloaded.read((data) => data.school)).toMatchObject({
      city: 'Ciudad de prueba',
      province: 'Provincia de prueba',
    })
  })

  it('una excepción de negocio no guarda cambios parciales ni emite un éxito', () => {
    db.read((data) => data)
    const before = values.get(KEY)
    const notify = vi.fn()
    db.onDatabaseChange(notify)
    expect(() =>
      db.transact((draft) => {
        draft.products.length = 0
        throw new Error('Operación rechazada')
      }),
    ).toThrow('Operación rechazada')
    expect(values.get(KEY)).toBe(before)
    expect(db.read((data) => data.products.length)).toBeGreaterThan(0)
    expect(notify).not.toHaveBeenCalled()
  })

  it('si el disco está lleno, falla y mantiene la última versión guardada en memoria', () => {
    const before = db.read((data) => data.school.city)
    const notify = vi.fn()
    db.onDatabaseChange(notify)
    storage.setItem.mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() =>
      db.transact((draft) => {
        draft.school.city = 'No guardado'
      }),
    ).toThrow('No se guardaron')
    expect(db.read((data) => data.school.city)).toBe(before)
    expect(notify).not.toHaveBeenCalled()
  })

  it('no crea una demo nueva si el navegador bloquea la lectura de datos', () => {
    storage.getItem.mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(() => db.read((data) => data)).toThrow('Habilitá el almacenamiento local')
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it.each(['{archivo roto', 'null', '{}', '{"version":2,"profiles":[]}'])(
    'conserva la base ilegible o incompleta: %s',
    (raw) => {
      values.set(KEY, raw)
      expect(() => db.read((data) => data)).toThrow(/conservaron/)
      expect(values.get(KEY)).toBe(raw)
      expect(storage.setItem).not.toHaveBeenCalled()
    },
  )

  it('impide sobrescribir datos de una aplicación más nueva', async () => {
    const future = structuredClone(db.read((data) => data))
    future.version = db.DB_VERSION + 1
    values.set(KEY, JSON.stringify(future))
    vi.resetModules()
    const olderApp = await import('./db')
    expect(() =>
      olderApp.transact((draft) => {
        draft.products.length = 0
      }),
    ).toThrow('versión más nueva')
    expect(JSON.parse(values.get(KEY)!).version).toBe(future.version)
  })

  it('migra datos v1 sin perder productos ni operaciones, y les agrega la contabilidad', async () => {
    const old = structuredClone(db.read((data) => data))
    old.version = 1
    old.documents = old.documents.filter((d) => d.doc_type !== 'JOURNAL_ENTRY')
    const raw = JSON.parse(JSON.stringify(old))
    delete raw.school.contact_email
    delete raw.school.session_timeout_minutes
    for (const key of ['jeLines', 'accounts', 'fiscalYears', 'fiscalPeriods']) delete raw[key]
    values.set(KEY, JSON.stringify(raw))
    vi.resetModules()
    const current = await import('./db')
    const upgraded = current.read((data) => data)
    expect(upgraded.version).toBe(current.DB_VERSION)
    expect(upgraded.products).toEqual(old.products)
    expect(upgraded.documents.filter((d) => d.doc_type !== 'JOURNAL_ENTRY')).toEqual(old.documents)
    expect(upgraded.school.session_timeout_minutes).toBe(15)
    expect(upgraded.accounts.length).toBeGreaterThan(50)
    expect(upgraded.documents.filter((d) => d.je?.origin === 'APERTURA')).toHaveLength(upgraded.companies.length)
    expect(JSON.parse(values.get(KEY)!).version).toBe(current.DB_VERSION)
  })

  // Las colecciones que trajo cada versión: una base guardada antes todavía no las tiene.
  const LATER: [number, string[]][] = [
    [14, ['jobCategories', 'employees']],
    [15, ['pyLines']],
    [18, ['laborAgreements']],
  ]
  it.each([13, 14, 17])(
    'abre una base guardada en la v%i, sin las colecciones que llegaron después',
    async (version) => {
      const raw = JSON.parse(JSON.stringify(db.read((data) => data)))
      raw.version = version
      const missing = LATER.filter(([since]) => since > version).flatMap(([, keys]) => keys)
      for (const key of missing) delete raw[key]
      values.set(KEY, JSON.stringify(raw))
      vi.resetModules()
      const current = await import('./db')
      const upgraded = current.read((data) => data) as unknown as Record<string, unknown>
      expect(upgraded.version).toBe(current.DB_VERSION)
      for (const key of missing) expect(Array.isArray(upgraded[key])).toBe(true)
      expect(JSON.parse(values.get(KEY)!).version).toBe(current.DB_VERSION)
    },
  )
})

describe('reinicio con respaldo obligatorio', () => {
  it('archiva la base completa antes de reemplazarla', () => {
    db.transact((draft) => {
      draft.school.city = 'Respaldar esta ciudad'
    })
    const previous = values.get(KEY)
    db.resetDatabase()
    const archives = [...values.entries()].filter(([key]) => key.startsWith('integrar-erp.archive.'))
    expect(archives).toHaveLength(1)
    expect(archives[0][1]).toBe(previous)
    expect(db.read((data) => data.school.city)).not.toBe('Respaldar esta ciudad')
  })

  it('cancela el reinicio si no se pudo guardar el respaldo', () => {
    db.transact((draft) => {
      draft.school.city = 'Conservar'
    })
    const previous = values.get(KEY)
    storage.setItem.mockImplementation((key: string, value: string) => {
      if (key.startsWith('integrar-erp.archive.')) throw new Error('Sin espacio')
      values.set(key, value)
    })
    expect(() => db.resetDatabase()).toThrow('reinicio se canceló')
    expect(values.get(KEY)).toBe(previous)
    expect(db.read((data) => data.school.city)).toBe('Conservar')
  })
})
