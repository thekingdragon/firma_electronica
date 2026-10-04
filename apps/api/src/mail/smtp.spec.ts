import { explainSmtpError, formatFrom, resolveSecure } from './smtp';

describe('smtp', () => {
  describe('resolveSecure', () => {
    it('deduce TLS directo solo en el 465', () => {
      expect(resolveSecure(465)).toBe(true);
      expect(resolveSecure(587)).toBe(false);
      expect(resolveSecure(25, null)).toBe(false);
    });
    it('el valor explícito manda sobre el puerto', () => {
      expect(resolveSecure(587, true)).toBe(true);
      expect(resolveSecure(465, false)).toBe(false);
    });
  });

  describe('formatFrom', () => {
    it('sin nombre, solo la dirección', () => {
      expect(formatFrom(null, 'a@b.co')).toBe('a@b.co');
    });
    it('con nombre, lo entrecomilla (soporta comas) y quita comillas internas', () => {
      expect(formatFrom('Andina, S.A.C.', 'a@b.co')).toBe('"Andina, S.A.C." <a@b.co>');
      expect(formatFrom('Un "nombre"', 'a@b.co')).toBe('"Un nombre" <a@b.co>');
    });
  });

  describe('explainSmtpError', () => {
    it('credenciales rechazadas', () => {
      expect(explainSmtpError({ code: 'EAUTH', message: '535 5.7.8 Username and Password not accepted' })).toMatch(
        /usuario o la contraseña/,
      );
    });
    it('no se puede conectar', () => {
      expect(explainSmtpError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' })).toMatch(/No se pudo conectar/);
      expect(explainSmtpError({ message: 'getaddrinfo ENOTFOUND smtp.x' })).toMatch(/No se pudo conectar/);
    });
    it('remitente no autorizado nombra las dos direcciones', () => {
      const msg = explainSmtpError({ message: 'a@x.com not allowed to send as b@y.com' });
      expect(msg).toContain('a@x.com');
      expect(msg).toContain('b@y.com');
    });
    it('poda el bloque de diagnóstico de Microsoft', () => {
      const largo = 'Rechazado [BeginDiagnosticData]' + '0x'.repeat(2000) + '[EndDiagnosticData] fin';
      const msg = explainSmtpError({ message: largo });
      expect(msg).not.toContain('0x0x');
      expect(msg.length).toBeLessThan(310);
    });
    it('un error sin mensaje da un texto por defecto', () => {
      expect(explainSmtpError({})).toMatch(/sin dar un motivo/);
    });
  });
});
