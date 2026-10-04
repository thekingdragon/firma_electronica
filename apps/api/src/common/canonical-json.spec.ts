import { canonicalJson } from './canonical-json';

describe('canonicalJson', () => {
  it('ordena las claves en todos los niveles', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('el orden de las claves no cambia el resultado', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it('conserva el orden de los arreglos', () => {
    expect(canonicalJson({ l: ['b', 'a'] })).toBe('{"l":["b","a"]}');
  });

  it('ignora claves undefined, como JSON.stringify', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('distingue contenidos distintos', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });
});
