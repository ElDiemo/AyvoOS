import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ENV, type Env } from '../config/env.js';
import { CalibrationService } from './calibration.service.js';
import { CodeLabelRenderer, PdfLibCodeLabelRenderer } from './code-label-pdf.js';
import { LabelArtworkService } from './label-artwork.service.js';
import { LabelPdfRenderer, PdfLibLabelRenderer } from './label-pdf-renderer.js';
import { LabelTemplatesService } from './label-templates.service.js';
import { LabelsController } from './labels.controller.js';

/**
 * labels module — the reusable LABEL ENGINE: label templates, immutable versions, layout
 * elements (mm geometry), artwork, the PDF label renderer and calibration/validation documents.
 * It knows nothing about bottles: callers pass plain `{ code, url }` labels to the renderer.
 * Exports LabelTemplatesService and LabelPdfRenderer (used by assets and label-production) and
 * CodeLabelRenderer (artwork-free QR + code labels, used by crates).
 */
@Module({
  imports: [
    MulterModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        // No `dest`/`storage`: multer keeps the upload in memory (bounded by the limit); it is
        // validated and only then written to file storage under a server-generated key.
        limits: { fileSize: env.LABEL_ARTWORK_MAX_BYTES, files: 1, fields: 0, parts: 2 },
      }),
    }),
  ],
  controllers: [LabelsController],
  providers: [
    LabelArtworkService,
    LabelTemplatesService,
    CalibrationService,
    { provide: LabelPdfRenderer, useClass: PdfLibLabelRenderer },
    { provide: CodeLabelRenderer, useClass: PdfLibCodeLabelRenderer },
  ],
  exports: [LabelTemplatesService, LabelPdfRenderer, CodeLabelRenderer],
})
export class LabelsModule {}
