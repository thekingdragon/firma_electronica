import { desfaseUtc, esZonaValida, fechaHoraEnZona, fechaLargaEnZona, minutosDeDesfase } from './fechas';

// 2026-10-05 02:30 UTC = 4 de octubre 21:30 en Lima (UTC-5): en UTC ya es «mañana».
const T = new Date(Date.UTC(2026, 9, 5, 2, 30, 15));

describe('fechas y zonas', () => {
  it('Lima es UTC-5 y no cambia en verano', () => {
    expect(minutosDeDesfase('America/Lima', T)).toBe(-300);
    expect(desfaseUtc('America/Lima', T)).toBe('UTC-5');
    expect(desfaseUtc('America/Lima', new Date(Date.UTC(2026, 0, 15)))).toBe('UTC-5');
  });

  it('el día es el de la zona, no el de UTC', () => {
    expect(fechaLargaEnZona(T, 'America/Lima')).toBe('4 de octubre de 2026');
    expect(fechaLargaEnZona(T, 'UTC')).toBe('5 de octubre de 2026');
  });

  it('la hora lleva SIEMPRE el desfase al lado', () => {
    expect(fechaHoraEnZona(T, 'America/Lima')).toBe('04/10/2026 21:30 (UTC-5)');
    expect(fechaHoraEnZona(T, 'America/Lima', { segundos: true })).toBe('04/10/2026 21:30:15 (UTC-5)');
    expect(fechaHoraEnZona(T, 'UTC')).toBe('05/10/2026 02:30 (UTC)');
  });

  it('con horario de verano el desfase es el de ESE instante', () => {
    expect(desfaseUtc('America/New_York', new Date(Date.UTC(2026, 6, 1)))).toBe('UTC-4');
    expect(desfaseUtc('America/New_York', new Date(Date.UTC(2026, 0, 1)))).toBe('UTC-5');
    expect(desfaseUtc('Asia/Kolkata', T)).toBe('UTC+5:30');
  });

  it('solo acepta nombres IANA que existen', () => {
    expect(esZonaValida('America/Lima')).toBe(true);
    expect(esZonaValida('UTC')).toBe(true);
    expect(esZonaValida('America/Argentina/Buenos_Aires')).toBe(true);
    expect(esZonaValida('-05')).toBe(false);
    expect(esZonaValida('lima')).toBe(false);
    expect(esZonaValida('America/Ciudad_Inventada')).toBe(false);
    expect(esZonaValida('')).toBe(false);
  });
});
