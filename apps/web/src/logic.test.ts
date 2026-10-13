import { describe, expect, it } from 'vitest';
import { newBlock, cleanBlocks, localProblems, type Block } from './blocks';
import { desfaseUtc, esZonaValida, fechaHoraEnZona, fechaHoraEnZonaIso, fechaLargaEnZona } from './fechas';
import { formatDateTime, formatDateTimeSeconds, setPanelZone, whatsappLink } from './format';
import { CARD_ASPECT, cardFrame, meetsMinimum } from './sign/useCamera';

// 5 de octubre 02:30 UTC = 4 de octubre 21:30 en Lima: en UTC ya es «mañana».
const T = new Date(Date.UTC(2026, 9, 5, 2, 30, 15));

describe('fechas y zonas (copia del navegador de la del servidor)', () => {
  it('Lima es UTC-5; el día y la hora son los de la zona, con el desfase al lado', () => {
    expect(desfaseUtc('America/Lima', T)).toBe('UTC-5');
    expect(fechaLargaEnZona(T, 'America/Lima')).toBe('4 de octubre de 2026');
    expect(fechaHoraEnZona(T, 'America/Lima')).toBe('04/10/2026 21:30 (UTC-5)');
    expect(fechaHoraEnZona(T, 'America/Lima', { segundos: true })).toBe('04/10/2026 21:30:15 (UTC-5)');
    expect(fechaHoraEnZonaIso(T.toISOString(), 'Asia/Tokyo')).toBe('05/10/2026 11:30 (UTC+9)');
  });

  it('un texto que no es fecha no rompe la pantalla', () => {
    expect(fechaHoraEnZonaIso('no-es-fecha', 'America/Lima')).toBe('—');
  });

  it('solo acepta zonas IANA que existen', () => {
    expect(esZonaValida('America/Lima')).toBe(true);
    for (const mala of ['-05', 'lima', 'America/Ciudad_Inventada', '']) expect(esZonaValida(mala)).toBe(false);
  });
});

describe('formato del panel', () => {
  it('usa la zona de la corredora de quien entró, con el desfase', () => {
    setPanelZone('America/Lima');
    expect(formatDateTime(T.toISOString())).toBe('04/10/2026 21:30 (UTC-5)');
    expect(formatDateTimeSeconds(T.toISOString())).toBe('04/10/2026 21:30:15 (UTC-5)');
    setPanelZone('Asia/Tokyo');
    expect(formatDateTime(T.toISOString())).toBe('05/10/2026 11:30 (UTC+9)');
  });

  it('sin corredora (operador) usa la zona del navegador y SIGUE mostrando el desfase', () => {
    setPanelZone(null);
    expect(formatDateTime(T.toISOString())).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2} \((UTC|UTC[+-][\d:]+)\)$/);
  });

  it('el enlace de WhatsApp arma el mensaje con el nombre del documento y rechaza teléfonos inválidos', () => {
    const link = whatsappLink('+51 999 888 777', 'Ana', 'https://firma.test/s/abc', 'Carta de nombramiento');
    expect(link).toContain('https://wa.me/51999888777?text=');
    expect(decodeURIComponent(link ?? '')).toContain('«Carta de nombramiento»');
    expect(whatsappLink('123', 'Ana', 'https://x', 'Doc')).toBeNull();
    expect(whatsappLink('abc', 'Ana', 'https://x', 'Doc')).toBeNull();
  });
});

describe('editor de bloques', () => {
  it('un bloque «lista de datos» nuevo toma el dato que le dice el tipo de documento (no uno de la carta)', () => {
    expect(newBlock('dataList', 'insurances')).toMatchObject({ type: 'dataList', dataKey: 'insurances' });
    expect(newBlock('dataList')).toMatchObject({ dataKey: '' });
  });

  it('sin dato válido el borrador lo marca; con dato, no', () => {
    const sin = [newBlock('dataList')];
    expect(localProblems(sin).join(' ')).toMatch(/nombre del dato/);
    expect(localProblems([newBlock('dataList', 'seguros')])).toEqual([]);
  });

  it('limpia las líneas vacías antes de enviar y marca facultades y consentimientos incompletos', () => {
    const lista = { ...(newBlock('list') as Extract<Block, { type: 'list' }>), items: ['uno', '  ', ''] };
    expect((cleanBlocks([lista])[0] as typeof lista).items).toEqual(['uno']);
    const facultad = newBlock('powers') as Extract<Block, { type: 'powers' }>;
    expect(localProblems([facultad]).join(' ')).toMatch(/falta el texto/);
    const consentimiento = newBlock('consent') as Extract<Block, { type: 'consent' }>;
    expect(localProblems([consentimiento]).join(' ')).toMatch(/falta el texto del consentimiento/);
    expect(localProblems([{ ...consentimiento, text: 'Acepto', code: 'minusculas' }]).join(' ')).toMatch(/mayúsculas/);
  });
});

describe('cámara: marco y pisos de resolución', () => {
  it('el marco del documento mantiene la proporción de una tarjeta y cabe con margen', () => {
    for (const [w, h] of [[1280, 720], [720, 1280], [640, 640]] as const) {
      const f = cardFrame(w, h);
      expect(f.w / f.h).toBeCloseTo(CARD_ASPECT, 5);
      expect(f.w).toBeLessThanOrEqual(w * 0.96 + 0.001);
      expect(f.h).toBeLessThanOrEqual(h * 0.96 + 0.001);
    }
  });

  it('la selfie vertical recortada de una laptop o un celular normal pasa el piso; una foto diminuta, no', () => {
    // 553×691 es lo que sale al recortar la selfie vertical de una laptop: el piso se bajó a propósito para aceptarla.
    expect(meetsMinimum(553, 691)).toBe(true);
    expect(meetsMinimum(720, 900)).toBe(true);
    expect(meetsMinimum(1280, 720)).toBe(true);
    expect(meetsMinimum(500, 500)).toBe(false);
    expect(meetsMinimum(300, 300)).toBe(false);
  });

  it('el documento exige más resolución que la selfie, en cualquier orientación', () => {
    expect(meetsMinimum(1000, 600, 'id')).toBe(true);
    expect(meetsMinimum(600, 1000, 'id')).toBe(true);
    expect(meetsMinimum(900, 560, 'id')).toBe(false);
    expect(meetsMinimum(900, 560, 'selfie')).toBe(true);
  });
});
