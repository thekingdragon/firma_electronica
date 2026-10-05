/**
 * Plantillas de partida que se le crean a un tenant nuevo. Son un punto de partida editable: el
 * tenant puede crear una versión nueva; una versión usada no se edita (ver document_templates).
 */
import { DEFAULT_LETTER_TEXTS } from '../documents/appointment-letter';

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

export function defaultTemplates(): TemplateSeed[] {
  return [
    {
      documentType: 'APPOINTMENT_LETTER',
      bodyJson: {
        // Mientras sea false, las plantillas no han pasado la revisión legal (ver ARQUITECTURA §8).
        legalReviewed: false,
        powers: FACULTADES_CARTA.map(([code, text]) => ({ code, text, defaultChecked: true })),
        observation: { maxLength: 1000 },
        // Redacción del documento: editable por tenant (otro país, otro modelo).
        texts: DEFAULT_LETTER_TEXTS,
      },
      annexText: ANEXO_A_CARTA,
      // BORRADOR: texto sujeto a revisión legal antes de usarse con clientes reales.
      clauseText:
        'Autorizo electrónicamente el nombramiento del corredor de seguros indicado, ' +
        'en los términos de esta carta, mediante la verificación de mi identidad en la fecha y ' +
        'hora que registra el sistema. [BORRADOR: texto sujeto a revisión legal]',
      otpRequired: true,
      photoRequired: true,
      photoChallengeRequired: true,
      idPhotoRequired: true,
    },
  ];
}
