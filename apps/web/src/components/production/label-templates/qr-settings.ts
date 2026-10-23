import type { LabelDesignerSettings } from '@ayvo/types';

/** Designer settings with the validated QR settings configured (ADR 0034). */
export type ConfiguredDesignerSettings = LabelDesignerSettings & {
  qrMinSizeMm: number;
  qrErrorCorrection: NonNullable<LabelDesignerSettings['qrErrorCorrection']>;
};

export function isConfigured(
  settings: LabelDesignerSettings,
): settings is ConfiguredDesignerSettings {
  return settings.qrMinSizeMm !== null && settings.qrErrorCorrection !== null;
}
