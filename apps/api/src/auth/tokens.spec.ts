import { createHmac } from 'node:crypto';
import { hashToken, newOpaqueToken, signToken, signingKey, verifyToken } from './tokens';

const SECRET = 's'.repeat(40);
const NOW = Date.UTC(2030, 0, 1, 12, 0, 0);

describe('tokens', () => {
  it('firma y verifica un testigo de acceso', () => {
    const t = signToken(SECRET, 'access', 'u1', 15, {}, NOW);
    expect(verifyToken(SECRET, 'access', t, NOW + 60_000)).toMatchObject({ sub: 'u1', typ: 'access' });
  });

  it('vence', () => {
    const t = signToken(SECRET, 'access', 'u1', 15, {}, NOW);
    expect(verifyToken(SECRET, 'access', t, NOW + 15 * 60_000 + 1000)).toBeNull();
  });

  it('un testigo intermedio NO sirve como sesión, ni al revés (claves y tipo distintos)', () => {
    const pending = signToken(SECRET, 'mfa-pending', 'u1', 5, { stage: 'verify' }, NOW);
    const access = signToken(SECRET, 'access', 'u1', 15, {}, NOW);
    expect(verifyToken(SECRET, 'access', pending, NOW)).toBeNull();
    expect(verifyToken(SECRET, 'mfa-pending', access, NOW)).toBeNull();
    expect(signingKey(SECRET, 'access').equals(signingKey(SECRET, 'mfa-pending'))).toBe(false);
  });

  it('rechaza una firma alterada, otra clave, alg=none y basura', () => {
    const t = signToken(SECRET, 'access', 'u1', 15, {}, NOW);
    const [h, b, s] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'otro', typ: 'access', iat: 1, exp: 9999999999 })).toString('base64url');
    expect(verifyToken(SECRET, 'access', `${h}.${forged}.${s}`, NOW)).toBeNull();
    expect(verifyToken('x'.repeat(40), 'access', t, NOW)).toBeNull();
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    expect(verifyToken(SECRET, 'access', `${none}.${b}.`, NOW)).toBeNull();
    // alg distinto aunque la firma sea del HMAC correcto
    const h2 = Buffer.from(JSON.stringify({ alg: 'HS512', typ: 'JWT' })).toString('base64url');
    const sig = createHmac('sha256', signingKey(SECRET, 'access')).update(`${h2}.${b}`).digest('base64url');
    expect(verifyToken(SECRET, 'access', `${h2}.${b}.${sig}`, NOW)).toBeNull();
    expect(verifyToken(SECRET, 'access', 'basura', NOW)).toBeNull();
    expect(verifyToken(SECRET, 'access', '', NOW)).toBeNull();
  });

  it('los tokens opacos son aleatorios y se guardan como hash', () => {
    const a = newOpaqueToken();
    expect(a).toHaveLength(64);
    expect(newOpaqueToken()).not.toBe(a);
    expect(hashToken(a)).not.toBe(a);
    expect(hashToken(a)).toBe(hashToken(a));
  });
});
