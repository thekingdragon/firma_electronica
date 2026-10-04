import { SlidingWindowLimiter } from './rate-limiter';

const T0 = 1_000_000;

describe('SlidingWindowLimiter', () => {
  it('permite hasta el límite y rechaza la siguiente', () => {
    const l = new SlidingWindowLimiter(60_000);
    for (let i = 1; i <= 5; i++) expect(l.hit('ip', 5, T0 + i).allowed).toBe(true);
    const r = l.hit('ip', 5, T0 + 6);
    expect(r.allowed).toBe(false);
    expect(r.count).toBe(6);
  });

  it('las peticiones salen de la ventana con el tiempo y se libera cupo', () => {
    const l = new SlidingWindowLimiter(60_000);
    for (let i = 0; i < 5; i++) l.hit('ip', 5, T0);
    expect(l.hit('ip', 5, T0 + 59_999).allowed).toBe(false);
    expect(l.hit('ip', 5, T0 + 60_001).allowed).toBe(true); // las 5 viejas ya salieron
  });

  it('es DESLIZANTE: no hay un reinicio brusco a los 60 s que permita doble ráfaga', () => {
    const l = new SlidingWindowLimiter(60_000);
    for (let i = 0; i < 5; i++) l.hit('ip', 5, T0 + 50_000); // ráfaga al final de la «ventana»
    // Un instante después aún cuentan: no se permite otra ráfaga al «cambiar de minuto».
    expect(l.hit('ip', 5, T0 + 61_000).allowed).toBe(false);
  });

  it('cada clave cuenta aparte', () => {
    const l = new SlidingWindowLimiter(60_000);
    for (let i = 0; i < 5; i++) l.hit('a', 5, T0);
    expect(l.hit('a', 5, T0).allowed).toBe(false);
    expect(l.hit('b', 5, T0).allowed).toBe(true);
  });

  it('los intentos rechazados también cuentan (insistir no ayuda)', () => {
    const l = new SlidingWindowLimiter(60_000);
    for (let i = 0; i < 5; i++) l.hit('ip', 5, T0);
    l.hit('ip', 5, T0 + 30_000); // rechazada
    l.hit('ip', 5, T0 + 31_000); // rechazada
    // A los 61 s salieron las 5 primeras, pero las 2 rechazadas siguen dentro de la ventana.
    expect(l.count('ip', T0 + 61_000)).toBe(2);
  });

  it('retryAfter dice cuántos segundos faltan para tener cupo', () => {
    const l = new SlidingWindowLimiter(60_000);
    for (let i = 0; i < 5; i++) l.hit('ip', 5, T0);
    const r = l.hit('ip', 5, T0 + 10_000);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSec).toBe(50); // las 5 viejas salen a T0 + 60 s
  });

  it('retryAfter es al menos 1 s y 0 si ya hay cupo', () => {
    const l = new SlidingWindowLimiter(60_000);
    expect(l.retryAfter('nada', 5, T0)).toBe(0);
    for (let i = 0; i < 6; i++) l.hit('ip', 5, T0);
    expect(l.retryAfter('ip', 5, T0 + 59_999)).toBeGreaterThanOrEqual(1);
  });

  it('un límite de 1 deja pasar una y rechaza la segunda', () => {
    const l = new SlidingWindowLimiter(60_000);
    expect(l.hit('ip', 1, T0).allowed).toBe(true);
    expect(l.hit('ip', 1, T0 + 1).allowed).toBe(false);
  });

  it('la memoria está acotada: pasado maxKeys se descartan las claves más viejas', () => {
    const l = new SlidingWindowLimiter(60_000, 100);
    for (let i = 0; i < 10_000; i++) l.hit(`ip-${i}`, 5, T0);
    expect(l.size).toBeLessThanOrEqual(100);
    // Lo más reciente se conserva.
    expect(l.count('ip-9999', T0)).toBe(1);
  });

  it('al descartar se va la clave INACTIVA, no una que sigue activa', () => {
    const l = new SlidingWindowLimiter(60_000, 3);
    l.hit('vieja', 5, T0);
    l.hit('b', 5, T0 + 1);
    l.hit('c', 5, T0 + 2);
    l.hit('vieja', 5, T0 + 3); // vuelve a tener actividad: ya no es la más antigua
    l.hit('d', 5, T0 + 4); // excede maxKeys: debe irse 'b', la inactiva
    expect(l.count('vieja', T0 + 5)).toBe(2);
    expect(l.count('b', T0 + 5)).toBe(0);
  });

  it('count no registra nada', () => {
    const l = new SlidingWindowLimiter(60_000);
    l.count('ip', T0);
    l.count('ip', T0);
    expect(l.size).toBe(0);
  });
});
