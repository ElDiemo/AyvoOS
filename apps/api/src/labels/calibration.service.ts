import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { LabelTemplatesService } from './label-templates.service.js';
import { requireQrLabelSettings, requireQrWidths } from './qr-label-settings.js';
import { renderQrValidationSheet, renderTemplateCalibration } from './calibration-pdf.js';

/** Calibration and QR validation documents (test prints, never bottle labels). */
@Injectable()
export class CalibrationService {
  constructor(
    private readonly labels: LabelTemplatesService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Needs no QR settings: it is the sheet that serves to validate them physically. */
  validationSheet(): Promise<Uint8Array> {
    return renderQrValidationSheet({ environment: this.env.APP_ENV, generatedAt: new Date() });
  }

  async templateCalibration(versionId: string): Promise<{ bytes: Uint8Array; filename: string }> {
    // A test print of a real template's QR uses (and so needs) the configured settings.
    const settings = requireQrLabelSettings(this.env);
    requireQrWidths(settings, await this.labels.qrElementWidths(versionId));
    const template = await this.labels.getRenderableVersion(versionId);
    const bytes = await renderTemplateCalibration({
      template,
      errorCorrection: settings.errorCorrection,
      devMarker: this.env.APP_ENV !== 'production',
    });
    return {
      bytes,
      filename: `calibration_${template.ref.templateName}-v${template.ref.versionNumber}.pdf`,
    };
  }
}
