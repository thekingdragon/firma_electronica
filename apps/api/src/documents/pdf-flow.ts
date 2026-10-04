import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb } from 'pdf-lib';

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
    if (this.y - h < MARGIN + FOOTER_SPACE) this.newPage();
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

  paragraph(text: string, opts: TextOptions = {}): void {
    const { size = 10, bold = false, indent = 0, after = 6, align = 'left', color = 'ink' } = opts;
    const font = this.fontFor(bold);
    const lineHeight = size * 1.35;
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
    const lines = this.wrap(text, this.regular, size, this.width - textIndent);
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
      if (line) this.page.drawText(line, { x: MARGIN + textIndent, y: this.y + size * 0.28, size, font: this.regular, color: INK });
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

  /** Pie de página con la referencia y «Página i de n» en todas las páginas. */
  footers(text: string): void {
    const pages = this.doc.getPages();
    pages.forEach((p, i) => {
      const label = this.safe(`${text}  ·  Página ${i + 1} de ${pages.length}`);
      const w = this.regular.widthOfTextAtSize(label, 8);
      p.drawText(label, { x: (A4[0] - w) / 2, y: MARGIN - 18, size: 8, font: this.regular, color: MUTED });
    });
  }
}
