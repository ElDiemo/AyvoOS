import { crateLabelLayout, type QrErrorCorrection } from '@ayvo/types';
import { domainError } from '../common/domain-error.js';
import type { Env } from '../config/env.js';

/**
 * The QR print settings of our own labels (bottles, crates, workstations): minimum QR size and
 * error correction (ADR 0014, doc 016). They stay PROVISIONAL until the physical print/scan
 * test; production carries no default for them (env.ts). Missing settings never stop the
 * application — they refuse only the operations that create, render, preview or hand out our
 * QR labels, every one of which goes through `requireQrLabelSettings`. Carrier labels (PPL PDF /
 * ZPL) and the QR validation sheet need neither and are never refused by this.
 */
export interface QrLabelSettings {
  minSizeMm: number;
  errorCorrection: QrErrorCorrection;
}

type QrEnv = Pick<Env, 'LABEL_QR_MIN_SIZE_MM' | 'LABEL_QR_ERROR_CORRECTION'>;

export function qrLabelSettings(env: QrEnv): QrLabelSettings | null {
  const minSizeMm = env.LABEL_QR_MIN_SIZE_MM;
  const errorCorrection = env.LABEL_QR_ERROR_CORRECTION;
  return minSizeMm === null || errorCorrection === null ? null : { minSizeMm, errorCorrection };
}

export function requireQrLabelSettings(env: QrEnv): QrLabelSettings {
  const settings = qrLabelSettings(env);
  if (!settings) {
    throw domainError(
      409,
      'QR_LABEL_SETTINGS_MISSING',
      'QR labels cannot be created or printed: the physically validated QR size and error ' +
        'correction (LABEL_QR_MIN_SIZE_MM, LABEL_QR_ERROR_CORRECTION) are not configured',
    );
  }
  return settings;
}

/**
 * For an existing print job: rendering or handing out its labels needs the current settings,
 * and the job must have been made with the error correction configured now — a job from before a
 * change is never printed with a level that is no longer the validated one.
 */
export function requireQrJobPrintable(env: QrEnv, jobErrorCorrection: string): QrLabelSettings {
  const settings = requireQrLabelSettings(env);
  if (jobErrorCorrection !== settings.errorCorrection) {
    throw domainError(
      409,
      'QR_LABEL_SETTINGS_CHANGED',
      `This print job was made with QR error correction ${jobErrorCorrection}, but ` +
        `${settings.errorCorrection} is configured now: create a new print job`,
    );
  }
  return settings;
}

/** Every QR element of a template must be at least the configured minimum size. */
export function requireQrWidths(settings: QrLabelSettings, qrWidthsMm: readonly number[]): void {
  const small = qrWidthsMm.find((w) => w < settings.minSizeMm);
  if (small !== undefined) {
    throw domainError(
      409,
      'QR_LABEL_TOO_SMALL',
      `The label's QR code would be ${small} mm wide, below the configured minimum of ` +
        `${settings.minSizeMm} mm`,
    );
  }
}

/**
 * A code label (crate, workstation: code-label-pdf.ts) of this size fits a readable QR code of at
 * least the configured minimum size.
 */
export function assertCodeLabelLayout(
  settings: QrLabelSettings,
  widthMm: number,
  heightMm: number,
): void {
  const layout = crateLabelLayout(widthMm, heightMm);
  if (!layout) {
    throw domainError(422, 'LABEL_TOO_SMALL', 'The label is too small for a readable QR code');
  }
  requireQrWidths(settings, [layout.qr.sizeMm]);
}
