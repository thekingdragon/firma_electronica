import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import { parseInline, type Piece } from './inline';

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 56;
const FOOTER_SPACE = 34;
const INK = rgb(0.1, 0.12, 0.16);
const MUTED = rgb(0.4, 0.43, 0.48);

export interface TextOptions {
  size?: number;
  bold?: boolean;
  indent?: number;
  /** Espacio debajo del párrafo. */
  after?: number;
  align?: 'left' | 'center' | 'right';
  color?: 'ink' | 'muted';
}

/**
 * Maquetador sencillo de arriba hacia abajo: lleva un cursor vertical, parte el texto en líneas del
 * ancho útil y abre una página nueva cuando no cabe lo siguiente. Solo usa las fuentes estándar del
 * PDF (Helvetica), que cubren el español completo (WinAnsi); todo lo que no cubran se reemplaza por
 * «?» en vez de reventar al generar el documento.
 */
export class PdfFlow {
  readonly width = A4[0] - MARGIN * 2;
  private page!: PDFPage;
  private y = 0;
  private readonly supported: Set<number>;
  /** Líneas del pie de página de la plantilla (iguales en todas las hojas) y el espacio que se les reserva. */
  private footerLines: Array<Array<Piece & { width: number }>> = [];
  private footerSpace = FOOTER_SPACE;

  private constructor(
    readonly doc: PDFDocument,
    private readonly regular: PDFFont,
    private readonly bold: PDFFont,
  ) {
    this.supported = new Set(regular.getCharacterSet());
    this.newPage();
  }

  static async create(): Promise<PdfFlow> {
    const doc = await PDFDocument.create();
    return new PdfFlow(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold));
  }

  newPage(): void {
    this.page = this.doc.addPage(A4);
    this.y = A4[1] - MARGIN;
  }

  /** Texto que la fuente puede dibujar; lo demás se cambia por «?». */
  safe(text: string): string {
    let out = '';
    for (const ch of text.normalize('NFC')) {
      const cp = ch.codePointAt(0) as number;
      out += cp === 0x09 ? '    ' : this.supported.has(cp) ? ch : '?';
    }
    return out;
  }

  private fontFor(bold?: boolean): PDFFont {
    return bold ? this.bold : this.regular;
  }

  /** Reserva `h` puntos; si no caben en la página, abre otra. */
  need(h: number): void {
    if (this.y - h < MARGIN + this.footerSpace) this.newPage();
  }

  gap(h: number): void {
    this.y -= h;
  }

  private wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const lines: string[] = [];
    // Se parte en líneas ANTES de limpiar: el salto de línea no está en la fuente y `safe` lo cambiaría por «?».
    for (const rawLine of text.split(/\r?\n/).map((l) => this.safe(l))) {
      if (rawLine.trim() === '') {
        lines.push('');
        continue;
      }
      let current = '';
      for (const word of rawLine.split(/\s+/).filter(Boolean)) {
        const candidate = current ? `${current} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
          current = candidate;
        } else {
          if (current) lines.push(current);
          // Una «palabra» más ancha que la línea (p. ej. un hash) se corta por caracteres.
          let rest = word;
          while (font.widthOfTextAtSize(rest, size) > maxWidth) {
            let n = rest.length;
            while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > maxWidth) n--;
            lines.push(rest.slice(0, n));
            rest = rest.slice(n);
          }
          current = rest;
        }
      }
      lines.push(current);
    }
    return lines;
  }

  /** Cómo quedaría partido un texto (para pruebas): las líneas ya limpias, sin dibujar nada. */
  measureLines(text: string, size = 10, bold = false, indent = 0): string[] {
    return this.wrap(text, this.fontFor(bold), size, this.width - indent);
  }

  /**
   * Reparte un texto con tramos en negrita (`**así**`) en líneas de un ancho dado. Cada línea es una lista de tramos
   * ya medidos. Las palabras no se parten entre líneas (salvo una más ancha que la línea, que se corta por caracteres);
   * el salto de línea del texto se respeta; una negrita que cruza un salto sigue en la línea de abajo.
   */
  private layoutRich(text: string, size: number, maxWidth: number, baseBold: boolean): Array<Array<Piece & { width: number }>> {
    const widthOf = (t: string, bold: boolean) => this.fontFor(bold).widthOfTextAtSize(t, size);
    // 1) Líneas duras: se corta en cada salto de línea, conservando la negrita de cada tramo.
    const hard: Piece[][] = [[]];
    for (const p of parseInline(text)) {
      const parts = p.text.split(/\r?\n/);
      parts.forEach((part, i) => {
        if (i > 0) hard.push([]);
        if (part) hard[hard.length - 1].push({ text: this.safe(part), bold: baseBold || p.bold });
      });
    }
    const out: Array<Array<Piece & { width: number }>> = [];
    for (const hl of hard) {
      if (hl.length === 0) {
        out.push([]);
        continue;
      }
      // 2) Palabras: una palabra puede estar formada por tramos pegados («**N.º 123**.» son dos tramos y una palabra).
      const words: Piece[][] = [];
      let cur: Piece[] = [];
      for (const p of hl) {
        for (const chunk of p.text.split(/(\s+)/)) {
          if (chunk === '') continue;
          if (/^\s+$/.test(chunk)) {
            if (cur.length) words.push(cur);
            cur = [];
          } else cur.push({ text: chunk, bold: p.bold });
        }
      }
      if (cur.length) words.push(cur);
      // 3) Se acomodan en líneas.
      let line: Array<Piece & { width: number }> = [];
      let lineWidth = 0;
      const space = widthOf(' ', false);
      const flush = () => {
        out.push(line);
        line = [];
        lineWidth = 0;
      };
      for (const word of words) {
        const ww = word.reduce((acc, p) => acc + widthOf(p.text, p.bold), 0);
        const needed = (line.length ? space : 0) + ww;
        if (line.length && lineWidth + needed > maxWidth) flush();
        if (ww > maxWidth) {
          // Una «palabra» más ancha que la línea (p. ej. un hash) se corta por caracteres.
          for (const p of word) {
            let rest = p.text;
            while (rest) {
              let n = rest.length;
              while (n > 1 && lineWidth + widthOf(rest.slice(0, n), p.bold) > maxWidth) n--;
              if (lineWidth + widthOf(rest.slice(0, n), p.bold) > maxWidth && line.length) {
                flush();
                continue;
              }
              const piece = rest.slice(0, n);
              line.push({ text: piece, bold: p.bold, width: widthOf(piece, p.bold) });
              lineWidth += widthOf(piece, p.bold);
              rest = rest.slice(n);
              if (rest) flush();
            }
          }
          continue;
        }
        if (line.length) {
          line.push({ text: ' ', bold: false, width: space });
          lineWidth += space;
        }
        for (const p of word) {
          const w = widthOf(p.text, p.bold);
          line.push({ text: p.text, bold: p.bold, width: w });
          lineWidth += w;
        }
      }
      flush();
    }
    return out;
  }

  private drawRichLine(line: Array<Piece & { width: number }>, x0: number, size: number, color: 'ink' | 'muted'): void {
    let x = x0;
    for (const p of line) {
      if (p.text.trim() !== '' || p.text === ' ') {
        if (p.text.trim() !== '') this.page.drawText(p.text, { x, y: this.y + size * 0.28, size, font: this.fontFor(p.bold), color: color === 'muted' ? MUTED : INK });
      }
      x += p.width;
    }
  }

  paragraph(text: string, opts: TextOptions = {}): void {
    const { size = 10, bold = false, indent = 0, after = 6, align = 'left', color = 'ink' } = opts;
    const lineHeight = size * 1.35;
    if (text.includes('**')) {
      // Con negrita dentro del texto: se maqueta por tramos.
      for (const line of this.layoutRich(text, size, this.width - indent, bold)) {
        this.need(lineHeight);
        const w = line.reduce((acc, p) => acc + p.width, 0);
        const x = MARGIN + indent + (align === 'center' ? (this.width - indent - w) / 2 : align === 'right' ? this.width - indent - w : 0);
        this.y -= lineHeight;
        this.drawRichLine(line, x, size, color);
      }
      this.y -= after;
      return;
    }
    const font = this.fontFor(bold);
    const lines = this.wrap(text, font, size, this.width - indent);
    for (const line of lines) {
      this.need(lineHeight);
      const w = font.widthOfTextAtSize(line, size);
      const x = MARGIN + indent + (align === 'center' ? (this.width - indent - w) / 2 : align === 'right' ? this.width - indent - w : 0);
      this.y -= lineHeight;
      if (line) this.page.drawText(line, { x, y: this.y + size * 0.28, size, font, color: color === 'muted' ? MUTED : INK });
    }
    this.y -= after;
  }

  /** «Etiqueta: valor» con la etiqueta en negrita, en una sola línea (o varias si el valor es largo). */
  field(label: string, value: string, opts: { indent?: number; size?: number; after?: number } = {}): void {
    const { indent = 0, size = 10, after = 3 } = opts;
    const lab = `${this.safe(label)} `;
    const labW = this.bold.widthOfTextAtSize(lab, size);
    const lines = this.wrap(value, this.regular, size, this.width - indent - labW);
    const lineHeight = size * 1.35;
    lines.forEach((line, i) => {
      this.need(lineHeight);
      this.y -= lineHeight;
      if (i === 0) this.page.drawText(lab, { x: MARGIN + indent, y: this.y + size * 0.28, size, font: this.bold, color: INK });
      if (line) this.page.drawText(line, { x: MARGIN + indent + labW, y: this.y + size * 0.28, size, font: this.regular, color: INK });
    });
    this.y -= after;
  }

  /** Línea con casilla marcada o vacía (no se usa «☑»: no está en la fuente estándar). */
  checkbox(checked: boolean, text: string, opts: { size?: number; indent?: number; after?: number } = {}): void {
    const { size = 10, indent = 0, after = 4 } = opts;
    const box = size;
    const textIndent = indent + box + 8;
    const lines = this.layoutRich(text, size, this.width - textIndent, false);
    const lineHeight = size * 1.35;
    this.need(lineHeight * Math.min(lines.length, 2));
    const top = this.y;
    this.page.drawRectangle({ x: MARGIN + indent, y: top - box - 1, width: box, height: box, borderColor: INK, borderWidth: 0.9 });
    if (checked) {
      const x0 = MARGIN + indent;
      const y0 = top - box - 1;
      this.page.drawLine({ start: { x: x0 + 2, y: y0 + 2 }, end: { x: x0 + box - 2, y: y0 + box - 2 }, thickness: 1.4, color: INK });
      this.page.drawLine({ start: { x: x0 + 2, y: y0 + box - 2 }, end: { x: x0 + box - 2, y: y0 + 2 }, thickness: 1.4, color: INK });
    }
    for (const line of lines) {
      this.need(lineHeight);
      this.y -= lineHeight;
      this.drawRichLine(line, MARGIN + textIndent, size, 'ink');
    }
    this.y -= after;
  }

  rule(): void {
    this.need(10);
    this.y -= 4;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: MARGIN + this.width, y: this.y }, thickness: 0.6, color: MUTED });
    this.y -= 8;
  }

  image(img: PDFImage, maxWidth: number, maxHeight: number): void {
    const scale = Math.min(maxWidth / img.width, maxHeight / img.height, 1);
    const w = img.width * scale;
    const h = img.height * scale;
    this.need(h + 8);
    this.y -= h;
    this.page.drawImage(img, { x: MARGIN, y: this.y, width: w, height: h });
    this.page.drawRectangle({ x: MARGIN, y: this.y, width: w, height: h, borderColor: MUTED, borderWidth: 0.6 });
    this.y -= 8;
  }

  /**
   * El pie de página de la plantilla. Se declara ANTES de maquetar el contenido: reserva el espacio al pie de cada hoja para que
   * el texto nunca quede debajo de él. Admite negrita (**). Vacío = sin pie propio.
   */
  setFooter(text: string): void {
    this.footerLines = text.trim() ? this.layoutRich(this.safe(text), 8, this.width, false) : [];
    this.footerSpace = FOOTER_SPACE + (this.footerLines.length ? this.footerLines.length * 10 + 8 : 0);
  }

  /** Pie de página con la referencia y «Página i de n» en todas las páginas, y encima el pie de la plantilla si lo hay. */
  footers(text: string): void {
    const pages = this.doc.getPages();
    pages.forEach((p, i) => {
      const label = this.safe(`${text}  ·  Página ${i + 1} de ${pages.length}`);
      const w = this.regular.widthOfTextAtSize(label, 8);
      p.drawText(label, { x: (A4[0] - w) / 2, y: MARGIN - 18, size: 8, font: this.regular, color: MUTED });
      // El pie de la plantilla, centrado, justo encima de la línea de referencia y página.
      this.footerLines.forEach((line, k) => {
        const lw = line.reduce((acc, piece) => acc + piece.width, 0);
        let x = (A4[0] - lw) / 2;
        const y = MARGIN - 18 + 14 + (this.footerLines.length - 1 - k) * 10;
        for (const piece of line) {
          if (piece.text.trim() !== '') p.drawText(piece.text, { x, y, size: 8, font: this.fontFor(piece.bold), color: INK });
          x += piece.width;
        }
      });
    });
  }
}
