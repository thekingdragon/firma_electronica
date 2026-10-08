/**
 * Formato dentro de un texto: lo que va entre `**dobles asteriscos**` sale en negrita (en la pantalla de firma y en el
 * PDF). Es lo único que se interpreta además de las variables; todo lo demás es texto plano.
 */
export interface Piece {
  text: string;
  bold: boolean;
}

const MARK = '**';

/** Parte un texto en tramos normales y en negrita. Un `**` sin cerrar deja en negrita hasta el final. */
export function parseInline(text: string): Piece[] {
  const out: Piece[] = [];
  let bold = false;
  for (const chunk of text.split(MARK)) {
    if (chunk) out.push({ text: chunk, bold });
    bold = !bold;
  }
  return out.length ? out : [{ text: '', bold: false }];
}

/** ¿Hay un `**` sin su pareja? (la validación al publicar lo rechaza). */
export function hasUnbalancedMarks(text: string): boolean {
  return (text.split(MARK).length - 1) % 2 === 1;
}

/** Un valor que va a quedar DENTRO del texto no puede traer sus propios `**`: abriría o cerraría una negrita. */
export function stripMarks(value: string): string {
  return value.split(MARK).join('');
}

/** El texto sin las marcas (para títulos del documento, vistas previas, etc.). */
export function plainText(text: string): string {
  return stripMarks(text);
}
