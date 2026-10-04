import { SESSION_TTL_SECONDS, issueSessionToken, verifySessionToken } from './session-token';

const SECRET = 's'.repeat(40);
const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);

describe('session-token', () => {
  it('un token recién emitido es válido para su solicitud', () => {
    const { token } = issueSessionToken(SECRET, 'req-1', T0);
    expect(verifySessionToken(SECRET, token, 'req-1', T0 + 1000)).toBe(true);
  });

  it('informa cuándo vence', () => {
    const { expiresAt } = issueSessionToken(SECRET, 'req-1', T0);
    expect(expiresAt.getTime()).toBe(T0 + SESSION_TTL_SECONDS * 1000);
  });

  it('vence: válido justo antes, inválido justo después', () => {
    const { token } = issueSessionToken(SECRET, 'req-1', T0);
    expect(verifySessionToken(SECRET, token, 'req-1', T0 + (SESSION_TTL_SECONDS - 1) * 1000)).toBe(true);
    expect(verifySessionToken(SECRET, token, 'req-1', T0 + SESSION_TTL_SECONDS * 1000)).toBe(false);
  });

  it('no sirve para otra solicitud', () => {
    const { token } = issueSessionToken(SECRET, 'req-1', T0);
    expect(verifySessionToken(SECRET, token, 'req-2', T0)).toBe(false);
  });

  it('no sirve con otro secreto', () => {
    const { token } = issueSessionToken(SECRET, 'req-1', T0);
    expect(verifySessionToken('x'.repeat(40), token, 'req-1', T0)).toBe(false);
  });

  it('detecta un payload alterado (p. ej. alargar el vencimiento)', () => {
    const { token } = issueSessionToken(SECRET, 'req-1', T0);
    const [, sig] = token.split('.');
    const forjado = Buffer.from(JSON.stringify({ r: 'req-1', e: Math.floor(T0 / 1000) + 999999 })).toString('base64url');
    expect(verifySessionToken(SECRET, `${forjado}.${sig}`, 'req-1', T0)).toBe(false);
  });

  it.each(['', 'basura', 'a.b.c', '.', 'abc.', '.abc'])('rechaza el token mal formado %p', (t) => {
    expect(verifySessionToken(SECRET, t, 'req-1', T0)).toBe(false);
  });
});
