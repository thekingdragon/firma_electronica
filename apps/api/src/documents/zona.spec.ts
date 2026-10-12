import { variableContextOf } from './render-blocks';

// 5 de octubre 02:30 UTC = 4 de octubre 21:30 en Lima: antes el documento decía «5 de octubre» a un firmante de Lima.
const signedAt = new Date(Date.UTC(2026, 9, 5, 2, 30, 15));
const base = { signer: { name: 'Ana', documentType: 'DNI', documentNumber: '1' }, reference: 'FE-1', signedAt };

describe('fecha del documento en la zona de la corredora', () => {
  it('Lima: el día es el 4, no el 5', () => {
    expect(variableContextOf({ ...base, issuer: { legalName: 'X', registryCode: null, timezone: 'America/Lima' } }).date).toBe('4 de octubre de 2026');
  });
  it('otra zona, otro día', () => {
    expect(variableContextOf({ ...base, issuer: { legalName: 'X', registryCode: null, timezone: 'Asia/Tokyo' } }).date).toBe('5 de octubre de 2026');
  });
});
