export interface HitResult {
  allowed: boolean;
  /** Cuántas peticiones lleva la clave dentro de la ventana (contando esta). */
  count: number;
  /** Segundos hasta que la más antigua salga de la ventana y se libere un cupo. */
  retryAfterSec: number;
}

/**
 * Ventana deslizante en memoria: guarda las marcas de tiempo de cada clave y cuenta las que caen en los
 * últimos `windowMs`. Es por proceso (si hubiera varias instancias, cada una cuenta lo suyo), lo que
 * basta para frenar a un cliente abusivo; no pretende ser un contador global exacto.
 *
 * La memoria está acotada: pasado `maxKeys` claves distintas se descartan las más viejas, así que un
 * atacante que rote direcciones no puede agotarla.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs = 60_000,
    private readonly maxKeys = 50_000,
  ) {}

  /** Registra una petición de `key` y dice si cabe dentro de `limit`. Una rechazada TAMBIÉN cuenta. */
  hit(key: string, limit: number, now = Date.now()): HitResult {
    const list = this.live(key, now);
    list.push(now);
    // Se borra antes de volver a poner: así la clave pasa al FINAL del orden de inserción y «la más
    // vieja» es de verdad la que lleva más tiempo sin actividad, no una clave activa.
    this.hits.delete(key);
    this.hits.set(key, list);
    this.evict();
    const allowed = list.length <= limit;
    return { allowed, count: list.length, retryAfterSec: allowed ? 0 : this.retryAfter(list, limit, now) };
  }

  /** Cuántas lleva `key` en la ventana, sin registrar nada. */
  count(key: string, now = Date.now()): number {
    return this.live(key, now).length;
  }

  /** Segundos hasta que `key` baje de `limit` (0 si ya está por debajo). */
  retryAfter(listOrKey: number[] | string, limit: number, now = Date.now()): number {
    const list = typeof listOrKey === 'string' ? this.live(listOrKey, now) : listOrKey;
    if (list.length <= limit) return 0;
    // La petición que, al salir de la ventana, deja la cuenta en `limit`.
    const pivot = list[list.length - limit - 1];
    return Math.max(1, Math.ceil((pivot + this.windowMs - now) / 1000));
  }

  get size(): number {
    return this.hits.size;
  }

  private live(key: string, now: number): number[] {
    const list = this.hits.get(key) ?? [];
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < list.length && list[i] <= cutoff) i++;
    return i ? list.slice(i) : list;
  }

  private evict(): void {
    // Un Map recuerda el orden de inserción: lo primero que aparece es lo más antiguo.
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.hits.delete(oldest);
    }
  }
}
