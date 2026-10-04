import { signWebhook, verifyWebhook } from './signing';

const SECRET = 'whsec_' + 'x'.repeat(40);
const BODY = '{"event":"signature.signed","data":{"x":1}}';
const NOW = 1_800_000_000;

describe('webhook signing', () => {
  // Vector calculado de forma INDEPENDIENTE (crypto directo, fuera de este módulo). Si la fórmula cambia
  // —por ejemplo, si el timestamp deja de ir dentro de lo firmado— esto falla; verificar con la misma
  // función que firma no lo detectaría, porque el error se cancela solo.
  it('coincide con el vector de referencia: HMAC-SHA256 de "<t>.<cuerpo>"', () => {
    const secret = 'whsec_golden_test_secret_0123456789abcdef';
    const body = '{"event":"signature.signed","id":"d1","data":{"reference":"FE-2026-ABCD1234"}}';
    expect(signWebhook(secret, 1_800_000_000, body)).toBe(
      't=1800000000,v1=a052bc8e2765ce004c1d4d25e1629ebf37ca4f03e5198f4c1011934f2995e3e3',
    );
  });

  it('la firma NO es la del cuerpo solo: el timestamp está dentro de lo firmado', () => {
    const secret = 'whsec_golden_test_secret_0123456789abcdef';
    const body = '{"event":"signature.signed","id":"d1","data":{"reference":"FE-2026-ABCD1234"}}';
    expect(signWebhook(secret, 1_800_000_000, body)).not.toContain('1abcb91286d692ce3cbe84caeea76bb39e642f907e686c737309b47e951606c7');
  });

  it('el formato es t=<unix>,v1=<64 hex>', () => {
    expect(signWebhook(SECRET, NOW, BODY)).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/);
  });

  it('una firma recién hecha se verifica', () => {
    expect(verifyWebhook(SECRET, signWebhook(SECRET, NOW, BODY), BODY, { nowSec: NOW })).toBe(true);
  });

  it('un cuerpo alterado, aunque sea un solo carácter, no se verifica', () => {
    const h = signWebhook(SECRET, NOW, BODY);
    expect(verifyWebhook(SECRET, h, BODY.replace('1', '2'), { nowSec: NOW })).toBe(false);
  });

  it('otro secreto no se verifica', () => {
    const h = signWebhook(SECRET, NOW, BODY);
    expect(verifyWebhook('otro-secreto-' + 'y'.repeat(30), h, BODY, { nowSec: NOW })).toBe(false);
  });

  it('el timestamp está firmado: cambiarlo invalida la firma', () => {
    const h = signWebhook(SECRET, NOW, BODY).replace(`t=${NOW}`, `t=${NOW + 10}`);
    expect(verifyWebhook(SECRET, h, BODY, { nowSec: NOW + 10 })).toBe(false);
  });

  it('rechaza un mensaje viejo (repetición) y uno del futuro, con tolerancia de 5 min', () => {
    const h = signWebhook(SECRET, NOW, BODY);
    expect(verifyWebhook(SECRET, h, BODY, { nowSec: NOW + 299 })).toBe(true);
    expect(verifyWebhook(SECRET, h, BODY, { nowSec: NOW + 301 })).toBe(false);
    expect(verifyWebhook(SECRET, h, BODY, { nowSec: NOW - 301 })).toBe(false);
  });

  it.each(['', 'basura', 't=abc,v1=00', 't=1', 'v1=00', 't=1800000000,v1=zz', 't=1800000000,v1='])(
    'una cabecera mal formada (%p) no revienta: simplemente no se verifica',
    (h) => {
      expect(verifyWebhook(SECRET, h, BODY, { nowSec: NOW })).toBe(false);
    },
  );
});
