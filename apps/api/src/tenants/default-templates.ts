/**
 * Plantillas de partida que se le crean a un tenant nuevo. Son un punto de partida editable: el
 * tenant puede crear una versión nueva; una versión usada no se edita (ver document_templates).
 */
import { DEFAULT_LETTER_TEXTS } from '../documents/appointment-letter-texts';
import { blocksFromLegacy, type Block } from '../documents/blocks';

export interface TemplateSeed {
  documentType: string;
  bodyJson: Record<string, unknown>;
  annexText: string | null;
  clauseText: string;
  otpRequired: boolean;
  photoRequired: boolean;
  photoChallengeRequired: boolean;
  /** Segunda foto, la del documento de identidad (exige photoRequired). */
  idPhotoRequired: boolean;
  /** Reverso del documento de identidad (exige idPhotoRequired). */
  idPhotoBackRequired: boolean;
}

// Facultades del art. 32.1 de la Res. SBS 809-2019 (Anexo I, modelo de carta de nombramiento).
const FACULTADES_CARTA = [
  ['GESTIONAR_SOLICITUD', 'Gestionar la solicitud del seguro, firmando para tal efecto la solicitud respectiva.'],
  ['RENOVACIONES', 'Solicitar y/o aceptar las renovaciones de las pólizas de seguros.'],
  ['MODIFICACIONES', 'Solicitar modificaciones a las pólizas de seguros.'],
  ['SINIESTROS', 'Presentar la documentación correspondiente para solicitar la cobertura del seguro en caso de siniestros.'],
  ['RECLAMOS', 'Presentar reclamos relacionados con las pólizas de seguros intermediadas.'],
  ['AJUSTADOR', 'Designar al ajustador de siniestros.'],
] as const;

// Anexo a la carta de nombramiento (art. 32.4): obligaciones del corredor y póliza de RC.
const ANEXO_A_CARTA = `Obligaciones del corredor de seguros

De manera previa al contrato de seguros:
a. Asesorar sobre las coberturas más convenientes, informando al contratante y/o asegurado sobre las condiciones del contrato, que comprende la cobertura básica, coberturas adicionales, exclusiones, franquicias, deducibles o similares, forma y plazos para el pago de la prima, efectos de su incumplimiento, derechos y obligaciones del contrato de seguro, y en general, toda la información necesaria para que tome una decisión informada.
b. Presentar un número suficiente de pólizas de seguro para formular una recomendación respecto de la póliza más adecuada a las necesidades del contratante y/o asegurado, a fin de que se tome una decisión informada.
c. Informar a los contratantes y/o asegurados sobre el rechazo a la solicitud de seguro o las modificaciones de cobertura del riesgo propuesto.
d. Requerir la autorización del contratante y/o asegurado para solicitar el seguro y firmar la solicitud respectiva.

Una vez aceptada la cobertura por la empresa de seguros:
a. Verificar que la póliza remitida por la empresa de seguros al contratante contenga las coberturas solicitadas.
b. Entregar a los contratantes y/o asegurados la información que ellos requieran sobre la póliza de seguros.
c. Prestar asesoría durante la vigencia del contrato, sobre el contenido y condiciones de la póliza, así como sobre las obligaciones que debe cumplir para que las condiciones de cobertura se mantengan, de acuerdo con la naturaleza del producto.
d. Proporcionar a las empresas de seguros información completa y relevante relativa a los bienes asegurados, estado real del riesgo e interés asegurable en el marco de las condiciones de la póliza.
e. Comunicar de inmediato a las empresas de seguros, cualquier modificación del riesgo asegurado que le haya sido informado por el contratante y/o asegurado, que signifique una agravación o disminución del riesgo que pudiera repercutir en las condiciones de aseguramiento.
f. Previa instrucción del contratante y/o asegurado, solicitar las renovaciones y las modificaciones a las pólizas de seguros.

Póliza de Responsabilidad Civil Profesional
Los corredores de seguros cuentan con una póliza de responsabilidad civil profesional que garantice el correcto y cabal cumplimiento de las responsabilidades asumidas en el ejercicio de las funciones y deberes de los corredores de seguros.

La póliza de responsabilidad civil profesional debe indemnizar por los perjuicios que pudieran ocasionar a los contratantes y/o asegurados en las pólizas que hayan intermediado, como consecuencia del incumplimiento de deberes y/u obligaciones, negligencia, impericia, errores u omisiones durante la ejecución de sus funciones.

El contratante, asegurado y/o beneficiario puede solicitar la cobertura de esta póliza de responsabilidad civil profesional cuando considere que la mala asesoría del corredor del seguro ha afectado la eficacia del seguro.`;

// Texto de partida del consentimiento de datos personales (Ley N.º 29733). Cada corredora lo ajusta en el panel
// con su domicilio y su correo de contacto; el texto definitivo es materia de la revisión legal.
const CONSENTIMIENTO_DATOS =
  'En cumplimiento de la Ley N.º 29733, Ley de Protección de Datos Personales, y su reglamento, autorizo, de manera ' +
  'libre, previa, expresa e informada, que **{{broker.legalName}}** trate y almacene mis datos personales en medios ' +
  'digitales, con la finalidad de brindarme asesoría en seguros, gestionar cotizaciones, emitir pólizas, atender ' +
  'siniestros y mantener comunicación relacionada con sus servicios. Declaro haber sido informado de que puedo ejercer ' +
  'mis derechos de acceso, rectificación, cancelación y oposición, así como solicitar copia de la información que se ' +
  'mantiene sobre mí, en cualquier momento y de forma gratuita, mediante comunicación dirigida a **{{broker.legalName}}**. ' +
  '[BORRADOR: texto sujeto a revisión legal]';

// Textos basados en cartas de nombramiento reales (se descartó todo lo de responsabilidad civil y reclamos). Se
// redactan en segunda persona («ustedes»), como el resto de la carta, que va dirigida a la corredora. Todo es
// editable desde el panel; el texto definitivo es materia de la revisión legal.
const VIGENCIA =
  'Este nombramiento reemplaza todos los demás que se hayan otorgado anteriormente. Asimismo, abarca todos los asuntos ' +
  'relativos a la negociación, colocación y administración de mis pólizas de seguros, conforme al marco regulatorio, y ' +
  'permanecerá vigente hasta que ustedes reciban una notificación escrita en contrario.';
const ASEGURADORAS =
  'Las aseguradoras a las cuales ustedes presenten esta comunicación deberán brindarles toda la asistencia que puedan ' +
  'solicitar en mi nombre, suministrándoles toda la información que requieran, incluyendo, pero no limitada a, pólizas, ' +
  'siniestralidad, límites, tasas, condiciones, aplicaciones anteriores y cualquier otra información que puedan ' +
  'necesitar para cumplir los deberes y obligaciones propios de su naturaleza en el corretaje y la asesoría en seguros.';
const ANEXO_REF =
  'Se adjuntan, en calidad de Anexo, las obligaciones del corredor de seguros, de conformidad con la Resolución SBS ' +
  'N.º 809-2019.';
const CONSENTIMIENTO_BENCHMARKING =
  'Autorizo a ustedes a incluir, de manera no identificable, información relativa a mi programa de seguros para ' +
  'realizar análisis comparativos (benchmarking), modelado y ofertas de análisis de datos y de seguros.';

const par = (id: string, text: string): Block => ({ id, type: 'paragraph', text, align: 'left', bold: false, small: false });

function carta(): Block[] {
  const base = blocksFromLegacy(
    {
      powers: FACULTADES_CARTA.map(([code, text]) => ({ code, text, defaultChecked: true })),
      observation: { maxLength: 1000 },
    },
    ANEXO_A_CARTA,
  );
  // Se arma en el orden de la carta: lo propio de cada bloque va justo después del que le corresponde.
  // La carta la escribe el cliente (primera persona): abre con SUS datos y la fecha, no con un membrete de la corredora.
  const out: Block[] = [
    par('cliente', 'Nombres y apellidos: **{{signer.name}}**\n{{signer.documentType}}: **{{signer.documentNumber}}**'),
    par('fecha', '{{date}}'),
  ];
  for (let b of base) {
    if (b.type === 'issuerHeader') continue;
    // «Señores: / CORREDORES DE SEGUROS / <razón social> / Presente.-» repetía el giro: la razón social ya lo incluye.
    if (b.id === 'destinatario' && b.type === 'paragraph') b = { ...b, text: 'Señores:\n**{{broker.legalName}}**\nPresente.-' };
    // «Estimados señores:» repetía «Señores:» a una línea de distancia. El saludo habitual de una carta formal es otro.
    // El cuerpo oficial de la SBS, precedido de quién escribe: los datos esenciales del firmante, en negrita.
    if (b.id === 'cuerpo' && b.type === 'paragraph') {
      const oficial = DEFAULT_LETTER_TEXTS.body;
      b = {
        ...b,
        text:
          'Yo, **{{signer.name}}**, identificado(a) con **{{signer.documentType}} N.º {{signer.documentNumber}}**, ' +
          oficial.charAt(0).toLowerCase() +
          oficial.slice(1),
      };
    }
    if (b.id === 'saludo' && b.type === 'paragraph') b = { ...b, text: 'De mi consideración:' };
    if (b.id === 'cierre') {
      // Los consentimientos van antes del cierre («Atentamente»), cada uno con su casilla.
      out.push({ id: 'datos', type: 'consent', code: 'DATOS_PERSONALES', text: CONSENTIMIENTO_DATOS, required: true });
      out.push({ id: 'benchmarking', type: 'consent', code: 'BENCHMARKING', text: CONSENTIMIENTO_BENCHMARKING, required: false });
    }
    out.push(b);
    if (b.id === 'facultades') {
      out.push(par('vigencia', VIGENCIA));
      out.push(par('aseguradoras', ASEGURADORAS));
      out.push(par('anexo-ref', ANEXO_REF));
    }
  }
  return out;
}

export function defaultTemplates(): TemplateSeed[] {
  return [
    {
      documentType: 'APPOINTMENT_LETTER',
      bodyJson: {
        // Mientras sea false, las plantillas no han pasado la revisión legal (ver ARQUITECTURA §8).
        legalReviewed: false,
        // La carta es una lista de bloques que la corredora edita desde el panel (otro país, otro modelo).
        blocks: carta(),
      },
      annexText: null,
      // BORRADOR: texto sujeto a revisión legal antes de usarse con clientes reales.
      clauseText:
        'Declaro haber leído la presente carta y sus anexos, y manifiesto mi conformidad con su contenido. Acepto ' +
        'suscribirla de manera electrónica, reconociendo que esta firma, junto con la fecha y hora que registra el ' +
        'sistema, tiene los mismos efectos que mi firma manuscrita. [BORRADOR: texto sujeto a revisión legal]',
      otpRequired: true,
      photoRequired: true,
      photoChallengeRequired: true,
      idPhotoRequired: true,
      idPhotoBackRequired: true,
    },
  ];
}
