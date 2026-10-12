/** Bloques de un documento tal como los edita el panel (espejo de apps/api/src/documents/blocks.ts). */

export interface PowerItem {
  code: string;
  text: string;
  defaultChecked: boolean;
}

export type Block =
  | { id: string; type: 'issuerHeader'; showRegistry: boolean; showDate: boolean }
  | { id: string; type: 'title'; text: string }
  | { id: string; type: 'heading'; text: string }
  | { id: string; type: 'paragraph'; text: string; align: 'left' | 'center' | 'right'; bold: boolean; small: boolean }
  | { id: string; type: 'list'; items: string[]; style: 'check' | 'bullet' | 'letters' }
  | { id: string; type: 'dataList'; dataKey: string; style: 'letters' | 'bullet' }
  | {
      id: string;
      type: 'powers';
      intro: string;
      items: PowerItem[];
      observation: { enabled: boolean; label: string; maxLength: number };
    }
  | { id: string; type: 'consent'; code: string; text: string; required: boolean }
  | { id: string; type: 'signerBox'; title: string }
  | { id: string; type: 'signatureStamp' }
  | { id: string; type: 'annex'; title: string; subtitle: string; text: string }
  | { id: string; type: 'pageBreak' };

export type BlockType = Block['type'];

export const BLOCK_LABEL: Record<BlockType, string> = {
  issuerHeader: 'Encabezado de la corredora',
  title: 'Título',
  heading: 'Subtítulo',
  paragraph: 'Párrafo',
  list: 'Lista de elementos',
  dataList: 'Lista de datos de la solicitud',
  powers: 'Facultades (las marca el firmante)',
  consent: 'Consentimiento (casilla propia)',
  signerBox: 'Datos del firmante',
  signatureStamp: 'Constancia de la firma y aceptación',
  annex: 'Anexo (página nueva)',
  pageBreak: 'Salto de página',
};

/** Qué bloques solo pueden estar una vez en el documento. */
export const SINGLE_BLOCKS: readonly BlockType[] = ['issuerHeader', 'powers', 'signerBox', 'signatureStamp'];

export const BLOCK_HELP: Partial<Record<BlockType, string>> = {
  issuerHeader: 'Razón social, código de registro y fecha, arriba a la izquierda y a la derecha.',
  dataList: 'Lista que llega con la solicitud, tomada del dato cuyo nombre se indica en el bloque.',
  powers: 'El firmante marca cuáles otorga. Solo puede haber un bloque de facultades.',
  consent: 'Casilla aparte que el firmante marca. Obligatoria: sin marcarla no puede firmar. Opcional: queda registrado si la marcó o no. Cada una se guarda por separado.',
  signerBox: 'Nombre y documento del firmante, tomados de la solicitud.',
  signatureStamp: 'En el PDF queda aquí la fecha de la firma y el texto de aceptación. En pantalla, la aceptación va siempre al final.',
  annex: 'Empieza en una página nueva. Una línea sola y corta se muestra como subtítulo.',
};

/** Identificador corto y único dentro del documento (el servidor acepta letras, números, guion y guion bajo). */
export function newId(): string {
  const a = new Uint8Array(5);
  crypto.getRandomValues(a);
  return 'b' + Array.from(a, (x) => x.toString(36).padStart(2, '0')).join('');
}

/** `defaultListKey`: dato de la solicitud que alimenta un bloque «lista de datos» nuevo (lo define el tipo de documento). */
export function newBlock(type: BlockType, defaultListKey = ''): Block {
  const id = newId();
  switch (type) {
    case 'issuerHeader':
      return { id, type, showRegistry: true, showDate: true };
    case 'title':
      return { id, type, text: 'TÍTULO DEL DOCUMENTO' };
    case 'heading':
      return { id, type, text: 'Subtítulo' };
    case 'paragraph':
      return { id, type, text: '', align: 'left', bold: false, small: false };
    case 'list':
      return { id, type, items: [''], style: 'check' };
    case 'dataList':
      return { id, type, dataKey: defaultListKey, style: 'letters' };
    case 'powers':
      return {
        id,
        type,
        intro: 'Por lo tanto, se encuentran facultados para realizar los siguientes actos en mi representación:',
        items: [{ code: 'FACULTAD_1', text: '', defaultChecked: true }],
        observation: { enabled: true, label: 'Observación:', maxLength: 1000 },
      };
    case 'consent':
      return { id, type, code: 'CONSENTIMIENTO_1', text: '', required: true };
    case 'signerBox':
      return { id, type, title: 'Datos del contratante o asegurado' };
    case 'signatureStamp':
      return { id, type };
    case 'annex':
      return { id, type, title: 'ANEXO', subtitle: '', text: '' };
    case 'pageBreak':
      return { id, type };
  }
}

/** Lo que se manda al servidor: sin líneas vacías en las listas (el borrador las admite mientras se escribe). */
export function cleanBlocks(blocks: Block[]): Block[] {
  return blocks.map((b) => {
    if (b.type === 'list') return { ...b, items: b.items.map((s) => s.trim()).filter(Boolean) };
    if (b.type === 'powers') return { ...b, items: b.items.filter((i) => i.text.trim() !== '' || i.code.trim() !== '') };
    return b;
  });
}

/** Problemas evidentes del borrador, para marcarlos antes de ir al servidor (el servidor valida igual). */
export function localProblems(blocks: Block[]): string[] {
  const out: string[] = [];
  blocks.forEach((b, i) => {
    const where = `Bloque ${i + 1} (${BLOCK_LABEL[b.type]})`;
    if (b.type === 'list' && b.items.every((s) => s.trim() === '')) out.push(`${where}: escriba al menos un elemento.`);
    if (b.type === 'powers') {
      b.items.forEach((it, j) => {
        if (!it.text.trim()) out.push(`${where}, facultad ${j + 1}: falta el texto.`);
        if (!/^[A-Z][A-Z0-9_]{0,39}$/.test(it.code)) out.push(`${where}, facultad ${j + 1}: el código va en mayúsculas, sin espacios.`);
      });
    }
    if (b.type === 'consent') {
      if (!b.text.trim()) out.push(`${where}: falta el texto del consentimiento.`);
      if (!/^[A-Z][A-Z0-9_]{0,39}$/.test(b.code)) out.push(`${where}: el código va en mayúsculas, sin espacios.`);
    }
    if (b.type === 'annex' && !b.text.trim()) out.push(`${where}: falta el texto del anexo.`);
    if (b.type === 'dataList' && !/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(b.dataKey)) out.push(`${where}: el nombre del dato no es válido.`);
  });
  return out;
}
