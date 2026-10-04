/**
 * JSON con las claves ordenadas, para que el mismo contenido dé siempre los mismos bytes y, por
 * tanto, el mismo hash. Se usa para el hash del snapshot y para detectar que una clave de
 * idempotencia se reutilizó con un cuerpo distinto.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .filter((k) => obj[k] !== undefined)
        .map((k) => [k, sortKeys(obj[k])]),
    );
  }
  return value;
}
