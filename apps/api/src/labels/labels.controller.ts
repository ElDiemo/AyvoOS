import {
  createLabelTemplateRequestSchema,
  createLabelTemplateVersionRequestSchema,
  type CreateLabelTemplateRequest,
  type CreateLabelTemplateVersionRequest,
  type CreateLabelTemplateVersionResponse,
  type LabelArtwork,
  type LabelDesignerSettings,
  type LabelTemplateDetail,
  type LabelTemplateSummary,
  type LabelTemplateVersion,
} from '@ayvo/types';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Header,
  Post,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { publicQrUrl } from '../common/qr-policy.js';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ENV, type Env } from '../config/env.js';
import { CalibrationService } from './calibration.service.js';
import { qrLabelSettings } from './qr-label-settings.js';
import { LabelArtworkService } from './label-artwork.service.js';
import { ASPECT_RATIO_TOLERANCE, LabelTemplatesService } from './label-templates.service.js';
import { RequirePermission } from '../identity/access.decorators.js';

/** The part of multer's in-memory file object this controller uses. */
interface UploadedArtworkFile {
  buffer: Buffer;
  originalname: string;
}

/** Admin API of the labels module. Business logic lives in the services. */
@Controller(ADMIN_PREFIX)
export class LabelsController {
  constructor(
    private readonly artworks: LabelArtworkService,
    private readonly templates: LabelTemplatesService,
    private readonly calibration: CalibrationService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @RequirePermission('production:read')
  @Get('label-designer/settings')
  settings(): LabelDesignerSettings {
    // Readable without the QR settings (null): bottle details and template history stay usable;
    // only the QR label operations themselves are refused (qr-label-settings.ts).
    const qr = qrLabelSettings(this.env);
    return {
      qrMinSizeMm: qr?.minSizeMm ?? null,
      artworkMaxBytes: this.env.LABEL_ARTWORK_MAX_BYTES,
      aspectRatioTolerance: ASPECT_RATIO_TOLERANCE,
      qrErrorCorrection: qr?.errorCorrection ?? null,
      // Same length as a real QR URL, so the preview has the real module density.
      qrPreviewUrl: publicQrUrl(this.env.PUBLIC_QR_BASE_URL, 'A'.repeat(22)),
    };
  }

  /** multipart/form-data with one `file` field. Size limit: LABEL_ARTWORK_MAX_BYTES (413). */
  @RequirePermission('production:templates_manage')
  @Post('label-artworks')
  @UseInterceptors(FileInterceptor('file'))
  upload(@UploadedFile() file: UploadedArtworkFile | undefined): Promise<LabelArtwork> {
    if (!file) throw new BadRequestException('Attach the artwork as the "file" field');
    return this.artworks.upload(file.buffer, file.originalname);
  }

  @RequirePermission('production:read')
  @Get('label-artworks/:id/content')
  @Header('Cache-Control', 'private, max-age=31536000, immutable')
  // SVG is shown as an image only; the sandbox CSP neutralises it if opened directly.
  @Header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
  )
  @Header('X-Content-Type-Options', 'nosniff')
  async content(@Param('id', ParseUUIDPipe) id: string): Promise<StreamableFile> {
    const { bytes, contentType } = await this.artworks.getContent(id);
    return new StreamableFile(bytes, { type: contentType, disposition: 'inline' });
  }

  @RequirePermission('production:read')
  @Get('label-templates')
  list(): Promise<LabelTemplateSummary[]> {
    return this.templates.list();
  }

  @RequirePermission('production:templates_manage')
  @Post('label-templates')
  create(
    @Body(new ZodValidationPipe(createLabelTemplateRequestSchema)) body: CreateLabelTemplateRequest,
  ): Promise<LabelTemplateVersion> {
    return this.templates.create(body.name, body.layout);
  }

  @RequirePermission('production:read')
  @Get('label-templates/:id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<LabelTemplateDetail> {
    return this.templates.get(id);
  }

  @RequirePermission('production:templates_manage')
  @Post('label-templates/:id/versions')
  @HttpCode(200)
  createVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createLabelTemplateVersionRequestSchema))
    body: CreateLabelTemplateVersionRequest,
  ): Promise<CreateLabelTemplateVersionResponse> {
    return this.templates.createVersion(id, body.layout);
  }

  @RequirePermission('production:templates_manage')
  @Post('label-templates/:id/archive')
  @HttpCode(200)
  archive(@Param('id', ParseUUIDPipe) id: string): Promise<LabelTemplateDetail> {
    return this.templates.setArchived(id, true);
  }

  @RequirePermission('production:templates_manage')
  @Post('label-templates/:id/restore')
  @HttpCode(200)
  restore(@Param('id', ParseUUIDPipe) id: string): Promise<LabelTemplateDetail> {
    return this.templates.setArchived(id, false);
  }

  /** A4 sheet with 10/12/15/18 mm × EC M/Q QR variants for the physical print/scan test. */
  @RequirePermission('production:read')
  @Get('label-calibration/qr-validation-sheet.pdf')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async validationSheet(): Promise<StreamableFile> {
    const pdf = await this.calibration.validationSheet();
    return pdfFile(pdf, 'ayvo-qr-validation-sheet.pdf');
  }

  /** One page at the template version's exact size, with 10 mm reference and scaling warning. */
  @RequirePermission('production:read')
  @Get('label-template-versions/:id/calibration.pdf')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async templateCalibration(@Param('id', ParseUUIDPipe) id: string): Promise<StreamableFile> {
    const { bytes, filename } = await this.calibration.templateCalibration(id);
    return pdfFile(bytes, filename);
  }

  @RequirePermission('production:read')
  @Get('label-template-versions/:id')
  getVersion(@Param('id', ParseUUIDPipe) id: string): Promise<LabelTemplateVersion> {
    return this.templates.getVersion(id);
  }
}

function pdfFile(bytes: Uint8Array, filename: string): StreamableFile {
  return new StreamableFile(Buffer.from(bytes), {
    type: 'application/pdf',
    disposition: `attachment; filename="${filename}"`,
    length: bytes.length,
  });
}
