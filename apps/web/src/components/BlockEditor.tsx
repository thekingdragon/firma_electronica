import { useState } from 'react';
import { BLOCK_HELP, BLOCK_LABEL, SINGLE_BLOCKS, newBlock, type Block, type BlockType } from '../blocks';

const ALL_TYPES = Object.keys(BLOCK_LABEL) as BlockType[];

const codeOf = (v: string) => v.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 40);

/** Un bloque: sus campos según el tipo. */
function Fields({ block, onChange }: { block: Block; onChange: (b: Block) => void }) {
  const id = block.id;
  switch (block.type) {
    case 'issuerHeader':
      return (
        <div className="row-checks">
          <label className="check">
            <input type="checkbox" checked={block.showRegistry} onChange={(e) => onChange({ ...block, showRegistry: e.target.checked })} />
            <span>Mostrar el código de registro</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={block.showDate} onChange={(e) => onChange({ ...block, showDate: e.target.checked })} />
            <span>Mostrar la fecha</span>
          </label>
        </div>
      );
    case 'title':
    case 'heading':
      return (
        <div>
          <label htmlFor={`t-${id}`}>Texto</label>
          <input id={`t-${id}`} type="text" maxLength={300} value={block.text} onChange={(e) => onChange({ ...block, text: e.target.value })} />
        </div>
      );
    case 'paragraph':
      return (
        <div>
          <label htmlFor={`p-${id}`}>Texto</label>
          <textarea id={`p-${id}`} rows={4} maxLength={5000} value={block.text} onChange={(e) => onChange({ ...block, text: e.target.value })} />
          <div className="row-checks">
            <label className="inline">
              Alineación
              <select value={block.align} onChange={(e) => onChange({ ...block, align: e.target.value as 'left' | 'center' | 'right' })}>
                <option value="left">Izquierda</option>
                <option value="center">Centrado</option>
                <option value="right">Derecha</option>
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={block.bold} onChange={(e) => onChange({ ...block, bold: e.target.checked })} />
              <span>Negrita</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={block.small} onChange={(e) => onChange({ ...block, small: e.target.checked })} />
              <span>Letra pequeña</span>
            </label>
          </div>
        </div>
      );
    case 'list':
      return (
        <div>
          <label htmlFor={`l-${id}`}>Elementos (uno por línea)</label>
          <textarea id={`l-${id}`} rows={5} value={block.items.join('\n')} onChange={(e) => onChange({ ...block, items: e.target.value.split('\n') })} />
          <label className="inline">
            Marca
            <select value={block.style} onChange={(e) => onChange({ ...block, style: e.target.value as 'check' | 'bullet' | 'letters' })}>
              <option value="check">✓ Casilla marcada</option>
              <option value="bullet">• Viñeta</option>
              <option value="letters">A. B. C. Letras</option>
            </select>
          </label>
        </div>
      );
    case 'dataList':
      return (
        <div className="row-checks">
          <label className="inline">
            Dato
            <input type="text" maxLength={40} value={block.dataKey} onChange={(e) => onChange({ ...block, dataKey: e.target.value })} />
          </label>
          <label className="inline">
            Marca
            <select value={block.style} onChange={(e) => onChange({ ...block, style: e.target.value as 'letters' | 'bullet' })}>
              <option value="letters">A. B. C. Letras</option>
              <option value="bullet">• Viñeta</option>
            </select>
          </label>
        </div>
      );
    case 'powers':
      return (
        <div>
          <label htmlFor={`pi-${id}`}>Texto de introducción</label>
          <textarea id={`pi-${id}`} rows={2} maxLength={5000} value={block.intro} onChange={(e) => onChange({ ...block, intro: e.target.value })} />

          <p className="checklist-title">Facultades que el firmante puede marcar</p>
          {block.items.map((it, j) => (
            <div key={j} className="power-row">
              <div className="power-code">
                <label htmlFor={`pc-${id}-${j}`}>Código</label>
                <input
                  id={`pc-${id}-${j}`}
                  type="text"
                  value={it.code}
                  onChange={(e) => onChange({ ...block, items: block.items.map((x, k) => (k === j ? { ...x, code: codeOf(e.target.value) } : x)) })}
                />
              </div>
              <div className="power-text">
                <label htmlFor={`pt-${id}-${j}`}>Texto</label>
                <textarea
                  id={`pt-${id}-${j}`}
                  rows={2}
                  maxLength={1000}
                  value={it.text}
                  onChange={(e) => onChange({ ...block, items: block.items.map((x, k) => (k === j ? { ...x, text: e.target.value } : x)) })}
                />
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={it.defaultChecked}
                  onChange={(e) => onChange({ ...block, items: block.items.map((x, k) => (k === j ? { ...x, defaultChecked: e.target.checked } : x)) })}
                />
                <span>Marcada de inicio</span>
              </label>
              <button type="button" className="btn btn-ghost" onClick={() => onChange({ ...block, items: block.items.filter((_, k) => k !== j) })}>
                Quitar
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn"
            onClick={() => onChange({ ...block, items: [...block.items, { code: `FACULTAD_${block.items.length + 1}`, text: '', defaultChecked: true }] })}
          >
            + Agregar facultad
          </button>

          <p className="checklist-title">Observación libre</p>
          <label className="check">
            <input
              type="checkbox"
              checked={block.observation.enabled}
              onChange={(e) => onChange({ ...block, observation: { ...block.observation, enabled: e.target.checked } })}
            />
            <span>Permitir que el firmante escriba una observación</span>
          </label>
          {block.observation.enabled && (
            <div className="row-checks">
              <label className="inline grow">
                Texto sobre el cuadro
                <input
                  type="text"
                  maxLength={1000}
                  value={block.observation.label}
                  onChange={(e) => onChange({ ...block, observation: { ...block.observation, label: e.target.value } })}
                />
              </label>
              <label className="inline">
                Máximo de caracteres
                <input
                  type="number"
                  min={1}
                  max={5000}
                  value={block.observation.maxLength}
                  onChange={(e) => onChange({ ...block, observation: { ...block.observation, maxLength: Math.max(1, Math.min(5000, Number(e.target.value) || 1)) } })}
                />
              </label>
            </div>
          )}
        </div>
      );
    case 'consent':
      return (
        <div>
          <label htmlFor={`ct-${id}`}>Texto del consentimiento</label>
          <textarea id={`ct-${id}`} rows={5} maxLength={3000} value={block.text} onChange={(e) => onChange({ ...block, text: e.target.value })} />
          <div className="row-checks">
            <label className="inline">
              Código (queda en la evidencia)
              <input type="text" value={block.code} onChange={(e) => onChange({ ...block, code: codeOf(e.target.value) })} />
            </label>
            <label className="check">
              <input type="checkbox" checked={block.required} onChange={(e) => onChange({ ...block, required: e.target.checked })} />
              <span>Obligatorio para firmar</span>
            </label>
          </div>
        </div>
      );
    case 'signerBox':
      return (
        <div>
          <label htmlFor={`s-${id}`}>Título</label>
          <input id={`s-${id}`} type="text" maxLength={300} value={block.title} onChange={(e) => onChange({ ...block, title: e.target.value })} />
        </div>
      );
    case 'annex':
      return (
        <div>
          <label htmlFor={`at-${id}`}>Título</label>
          <input id={`at-${id}`} type="text" maxLength={300} value={block.title} onChange={(e) => onChange({ ...block, title: e.target.value })} />
          <label htmlFor={`as-${id}`}>Subtítulo</label>
          <input id={`as-${id}`} type="text" maxLength={300} value={block.subtitle} onChange={(e) => onChange({ ...block, subtitle: e.target.value })} />
          <label htmlFor={`ax-${id}`}>Texto (separe los apartados con una línea en blanco)</label>
          <textarea id={`ax-${id}`} rows={10} maxLength={20000} value={block.text} onChange={(e) => onChange({ ...block, text: e.target.value })} />
        </div>
      );
    case 'signatureStamp':
    case 'pageBreak':
      return null;
  }
}

/**
 * Editor de la lista de bloques de un documento. Subir, bajar, quitar y agregar; cada bloque se edita con los
 * campos de su tipo. No guarda nada: quien lo usa decide cuándo publicar.
 */
export function BlockEditor({ blocks, onChange, defaultListKey }: { blocks: Block[]; onChange: (b: Block[]) => void; defaultListKey?: string }) {
  const [adding, setAdding] = useState<BlockType>('paragraph');

  const used = new Set(blocks.map((b) => b.type));
  const available = ALL_TYPES.filter((t) => !(SINGLE_BLOCKS.includes(t) && used.has(t)));

  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= blocks.length) return;
    const next = blocks.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="blocks">
      {blocks.map((b, i) => (
        <div key={b.id} className="block-card">
          <div className="block-head">
            <strong>
              {i + 1}. {BLOCK_LABEL[b.type]}
            </strong>
            <span className="block-tools">
              <button type="button" className="btn btn-ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Subir">
                ↑
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => move(i, 1)} disabled={i === blocks.length - 1} aria-label="Bajar">
                ↓
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => onChange(blocks.filter((_, k) => k !== i))} aria-label="Quitar">
                Quitar
              </button>
            </span>
          </div>
          {BLOCK_HELP[b.type] && <p className="hint">{BLOCK_HELP[b.type]}</p>}
          <Fields block={b} onChange={(nb) => onChange(blocks.map((x, k) => (k === i ? nb : x)))} />
        </div>
      ))}

      <div className="block-add">
        <label className="inline">
          Agregar
          <select value={available.includes(adding) ? adding : available[0]} onChange={(e) => setAdding(e.target.value as BlockType)}>
            {available.map((t) => (
              <option key={t} value={t}>
                {BLOCK_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn" onClick={() => onChange([...blocks, newBlock(available.includes(adding) ? adding : available[0], defaultListKey)])} disabled={available.length === 0}>
          + Agregar bloque
        </button>
      </div>
    </div>
  );
}
