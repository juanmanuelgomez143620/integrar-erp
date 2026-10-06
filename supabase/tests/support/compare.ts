// Comparación entre lo que devuelve la base y lo que devuelve el simulador.

/** Deja en `actual` sólo las claves que tiene `expected` (la base puede traer columnas de más). */
export function project(actual: unknown, expected: unknown): unknown {
  if (Array.isArray(actual) && Array.isArray(expected))
    return actual.map((a, i) => project(a, expected[Math.min(i, expected.length - 1)]))
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
