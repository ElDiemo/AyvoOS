import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { LabelTemplatesService } from './label-templates.service.js';
import { renderQrValidationSheet, renderTemplateCalibration } from './calibration-pdf.js';

/** Calibration and QR validation documents (test prints, never bottle labels). */
@Injectable()
export class CalibrationService {
  constructor(
    private readonly labels: LabelTemplatesService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  validationSheet(): Promise<Uint8Array> {
    return renderQrValidationSheet({ environment: this.env.APP_ENV, generatedAt: new Date() });
  }

  async templateCalibration(versionId: string): Promise<{ bytes: Uint8Array; filename: string }> {
    const template = await this.labels.getRenderableVersion(versionId);
    const bytes = await renderTemplateCalibration({
      template,
      errorCorrection: this.env.LABEL_QR_ERROR_CORRECTION,
      devMarker: this.env.APP_ENV !== 'production',
    });
    return {
      bytes,
      filename: `calibration_${template.ref.templateName}-v${template.ref.versionNumber}.pdf`,
    };
  }
}
