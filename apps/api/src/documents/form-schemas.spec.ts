import { defaultTemplates } from '../tenants/default-templates';
import { getDocumentType } from '../document-types';

const formSchemaFor = (code: string, content: Record<string, unknown>) => getDocumentType(code)?.formSchema(content) ?? null;

const content = defaultTemplates()[0].bodyJson;
const schema = formSchemaFor('APPOINTMENT_LETTER', content)!;

describe('formSchemaFor(APPOINTMENT_LETTER)', () => {
  it('acepta facultades de la plantilla y una observación', () => {
    const r = schema.safeParse({ powers: ['RENOVACIONES', 'RECLAMOS'], observation: 'Solo Ayacucho', consents: ['DATOS_PERSONALES'] });
    expect(r.success).toBe(true);
  });

  it('la observación es opcional (por defecto vacía)', () => {
    const r = schema.safeParse({ powers: ['AJUSTADOR'], consents: ['DATOS_PERSONALES'] });
    expect(r.success && r.data.observation).toBe('');
  });

  it('rechaza una facultad que no está en la plantilla', () => {
    expect(schema.safeParse({ powers: ['INVENTADA'], observation: '' }).success).toBe(false);
  });

  it('rechaza facultades repetidas', () => {
    expect(schema.safeParse({ powers: ['AJUSTADOR', 'AJUSTADOR'], observation: '' }).success).toBe(false);
  });

  it('sin facultades ni observación no vale: la carta no autorizaría nada', () => {
    expect(schema.safeParse({ powers: [], observation: '' }).success).toBe(false);
    expect(schema.safeParse({ powers: [], observation: '   ' }).success).toBe(false);
  });

  it('sin facultades pero con observación sí vale (el firmante especifica lo suyo)', () => {
    expect(schema.safeParse({ powers: [], observation: 'Solo presentar reclamos', consents: ['DATOS_PERSONALES'] }).success).toBe(true);
  });

  it('respeta el largo máximo de la observación de la plantilla', () => {
    expect(schema.safeParse({ powers: ['AJUSTADOR'], observation: 'x'.repeat(1000), consents: ['DATOS_PERSONALES'] }).success).toBe(true);
    expect(schema.safeParse({ powers: ['AJUSTADOR'], observation: 'x'.repeat(1001), consents: ['DATOS_PERSONALES'] }).success).toBe(false);
  });

  it('un campo extra es un error, no se ignora', () => {
    expect(schema.safeParse({ powers: ['AJUSTADOR'], observation: '', admin: true }).success).toBe(false);
  });

  it('un tipo sin esquema de formulario devuelve null', () => {
    expect(formSchemaFor('OTRO_TIPO', {})).toBeNull();
  });
});
