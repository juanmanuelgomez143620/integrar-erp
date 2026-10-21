// Comparación entre lo que devuelve la base y lo que devuelve el simulador.

const idOf = (x: unknown) => (x && typeof x === 'object' && 'id' in x ? (x as { id: unknown }).id : undefined)

/**
 * Deja en `actual` sólo las claves que tiene `expected` (la base puede traer
 * columnas de más). En una lista, cada elemento se proyecta sobre el esperado
 * con su mismo id (dos creados en el mismo instante pueden venir en otro
 * orden) o, si no lo hay, sobre el de su misma posición.
 */
export function project(actual: unknown, expected: unknown): unknown {
  if (Array.isArray(actual) && Array.isArray(expected)) {
    const byId = new Map(expected.filter((e) => idOf(e) !== undefined).map((e) => [idOf(e), e]))
    return actual.map((a, i) => project(a, byId.get(idOf(a)) ?? expected[Math.min(i, expected.length - 1)]))
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object' && !Array.isArray(actual))
    return Object.fromEntries(
      Object.keys(expected as object)
        .filter((k) => k in (actual as object))
        .map((k) => [k, project((actual as Record<string, unknown>)[k], (expected as Record<string, unknown>)[k])]),
    )
  return actual
}

/** Ordena dentro de cada grupo de elementos consecutivos con la misma clave (p. ej. creados en el mismo instante). */
export function sortTies(list: unknown, key: (x: never) => unknown): unknown {
  if (!Array.isArray(list)) return list
  const out: unknown[] = []
  for (let i = 0; i < list.length;) {
    let j = i + 1
    while (j < list.length && key(list[j] as never) === key(list[i] as never)) j++
    out.push(...list.slice(i, j).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)))
    i = j
  }
  return out
}
