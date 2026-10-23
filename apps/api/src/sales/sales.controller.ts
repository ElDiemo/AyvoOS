import {
  SALES_IMPORT_MAX_BYTES,
  archiveProspectRequestSchema,
  confirmImportSchema,
  importCodeSchema,
  importOptionsSchema,
  type ConfirmImportRequest,
  type ImportInspection,
  type ImportOptions,
  type ImportPreview,
  type ImportResult,
  type ImportSummary,
  cancelTaskRequestSchema,
  changeOwnerRequestSchema,
  changeStageRequestSchema,
  completeTaskRequestSchema,
  correctActivityRequestSchema,
  createProspectRequestSchema,
  createTaskRequestSchema,
  duplicateQuerySchema,
  prospectCodeSchema,
  prospectListQuerySchema,
  recordActivityRequestSchema,
  restoreProspectRequestSchema,
  rescheduleTaskRequestSchema,
  retireContactRequestSchema,
  saveContactRequestSchema,
  taskListQuerySchema,
  updateProspectRequestSchema,
  updateTaskRequestSchema,
  type ArchiveProspectRequest,
  type CancelTaskRequest,
  type ChangeOwnerRequest,
  type ChangeStageRequest,
  type CompleteTaskRequest,
  type CorrectActivityRequest,
  type CreateProspectRequest,
  type CreateTaskRequest,
  type DuplicateHint,
  type DuplicateQuery,
  type ProspectDetail,
  type ProspectListQuery,
  type ProspectPage,
  type RecordActivityRequest,
  type RescheduleTaskRequest,
  type RestoreProspectRequest,
  type RetireContactRequest,
  type SalesOverview,
  type Salesperson,
  type SaveContactRequest,
  type TaskListQuery,
  type TaskPage,
  type UpdateProspectRequest,
  type UpdateTaskRequest,
} from '@ayvo/types';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { z } from 'zod';
import { ADMIN_PREFIX } from '../common/routes.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../identity/access.decorators.js';
import { CurrentPrincipal } from '../identity/access.guard.js';
import type { Principal } from '../identity/principal.js';
import { ProspectsService } from './prospects.service.js';
import { SalesImportService, type UploadedCsv } from './sales-import.service.js';
import { scopeOf } from './sales-access.js';
import { SalesWorkService } from './sales-work.service.js';

const CODE = new ZodValidationPipe(prospectCodeSchema);
const IMPORT_CODE = new ZodValidationPipe(importCodeSchema);
/** One CSV file in memory (never stored), at most SALES_IMPORT_MAX_BYTES (413 above). */
const CSV_UPLOAD = FileInterceptor('file', {
  limits: { fileSize: SALES_IMPORT_MAX_BYTES, files: 1, fields: 2 },
});

/** The JSON form field next to the uploaded file, validated by its shared contract. */
class JsonField<T extends z.ZodType> extends ZodValidationPipe<T> {
  override transform(value: unknown): z.infer<T> {
    if (typeof value !== 'string') throw new BadRequestException('Send the options as JSON');
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new BadRequestException('Send the options as JSON');
    }
    return super.transform(parsed);
  }
}
const UUID = new ParseUUIDPipe();

/**
 * Obchod (doc 034). Every route needs `sales:work`; what the user sees inside is decided by
 * ownership or `sales:manage` in the services — for every read and write. No site is needed.
 */
@Controller(`${ADMIN_PREFIX}/sales`)
export class SalesController {
  constructor(
    private readonly prospects: ProspectsService,
    private readonly work: SalesWorkService,
    private readonly imports: SalesImportService,
  ) {}

  @RequirePermission('sales:work')
  @Get('overview')
  overview(
    @Query('scope') scope: string | undefined,
    @CurrentPrincipal() p: Principal,
  ): Promise<SalesOverview> {
    return this.prospects.overview(scopeOf(p), scope === 'all');
  }

  @RequirePermission('sales:work')
  @Get('prospects')
  list(
    @Query(new ZodValidationPipe(prospectListQuerySchema)) query: ProspectListQuery,
    @CurrentPrincipal() p: Principal,
  ): Promise<ProspectPage> {
    return this.prospects.list(scopeOf(p), query);
  }

  @RequirePermission('sales:work')
  @Get('prospects/duplicates')
  duplicates(
    @Query(new ZodValidationPipe(duplicateQuerySchema)) query: DuplicateQuery,
    @CurrentPrincipal() p: Principal,
  ): Promise<DuplicateHint> {
    return this.prospects.checkDuplicates(scopeOf(p), query);
  }

  @RequirePermission('sales:work')
  @Post('prospects')
  async create(
    @Body(new ZodValidationPipe(createProspectRequestSchema)) body: CreateProspectRequest,
    @CurrentPrincipal() p: Principal,
  ): Promise<ProspectDetail> {
    const { code } = await this.prospects.create(scopeOf(p), body);
    return this.prospects.detail(scopeOf(p), code);
  }

  /** The filtered list as CSV — all pages, in the user's scope (doc 034 §13). */
  @RequirePermission('sales:work')
  @Get('prospects/export')
  async exportCsv(
    @Query(new ZodValidationPipe(prospectListQuerySchema)) query: ProspectListQuery,
    @CurrentPrincipal() p: Principal,
  ): Promise<StreamableFile> {
    const csv = await this.prospects.exportCsv(scopeOf(p), query);
    return new StreamableFile(Buffer.from(csv, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="zajemci-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
  }

  // --- CSV import (doc 034 §13): inspect → preview (writes nothing) → confirm ---------------

  @RequirePermission('sales:work')
  @Post('imports/inspect')
  @HttpCode(200)
  @UseInterceptors(CSV_UPLOAD)
  inspectImport(@UploadedFile() file: UploadedCsv | undefined): ImportInspection {
    return this.imports.inspect(file);
  }

  @RequirePermission('sales:work')
  @Post('imports/preview')
  @HttpCode(200)
  @UseInterceptors(CSV_UPLOAD)
  previewImport(
    @UploadedFile() file: UploadedCsv | undefined,
    @Body('options', new JsonField(importOptionsSchema)) options: ImportOptions,
    @CurrentPrincipal() p: Principal,
  ): Promise<ImportPreview> {
    return this.imports.preview(scopeOf(p), file, options);
  }

  @RequirePermission('sales:work')
  @Post('imports')
  @UseInterceptors(CSV_UPLOAD)
  async confirmImport(
    @UploadedFile() file: UploadedCsv | undefined,
    @Body('options', new JsonField(confirmImportSchema)) body: ConfirmImportRequest,
    @CurrentPrincipal() p: Principal,
  ): Promise<ImportResult> {
    const { code } = await this.imports.confirm(scopeOf(p), file, body);
    return this.imports.result(scopeOf(p), code);
  }

  @RequirePermission('sales:work')
  @Get('imports')
  listImports(@CurrentPrincipal() p: Principal): Promise<ImportSummary[]> {
    return this.imports.list(scopeOf(p));
  }

  @RequirePermission('sales:work')
  @Get('imports/:code')
  importResult(
    @Param('code', IMPORT_CODE) code: string,
    @CurrentPrincipal() p: Principal,
  ): Promise<ImportResult> {
    return this.imports.result(scopeOf(p), code);
  }

  @RequirePermission('sales:work')
  @Get('prospects/:code')
  detail(
    @Param('code', CODE) code: string,
    @CurrentPrincipal() p: Principal,
  ): Promise<ProspectDetail> {
    return this.prospects.detail(scopeOf(p), code);
  }

  @RequirePermission('sales:work')
  @Post('prospects/:code/update')
  @HttpCode(200)
  update(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(updateProspectRequestSchema)) body: UpdateProspectRequest,
    @CurrentPrincipal() p: Principal,
  ): Promise<ProspectDetail> {
    return this.prospects.update(scopeOf(p), code, body);
  }

  @RequirePermission('sales:work')
  @Post('prospects/:code/stage')
  @HttpCode(200)
  stage(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(changeStageRequestSchema)) body: ChangeStageRequest,
    @CurrentPrincipal() p: Principal,
  ): Promise<ProspectDetail> {
    return this.prospects.changeStage(scopeOf(p), code, body);
  }

  /** Assignment to a salesperson: ADMIN (sales:manage) only. */
  @RequirePermission('sales:work', 'sales:manage')
  @Post('prospects/:code/owner')
  @HttpCode(200)
  owner(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(changeOwnerRequestSchema)) body: ChangeOwnerRequest,
    @CurrentPrincipal() p: Principal,
  ): Promise<ProspectDetail> {
    return this.prospects.changeOwner(scopeOf(p), code, body);
  }

  /** Archive / restore: the owner (or sales:manage) — never a stage change (doc 034 §3a). */
  @RequirePermission('sales:work')
  @Post('prospects/:code/archive')
  @HttpCode(200)
  archive(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(archiveProspectRequestSchema)) body: ArchiveProspectRequest,
    @CurrentPrincipal() p: Principal,
  ): Promise<ProspectDetail> {
    return this.prospects.archive(scopeOf(p), code, body);
  }

  @RequirePermission('sales:work')
  @Post('prospects/:code/restore')
  @HttpCode(200)
  restore(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(restoreProspectRequestSchema)) body: RestoreProspectRequest,
    @CurrentPrincipal() p: Principal,
  ): Promise<ProspectDetail> {
    return this.prospects.restore(scopeOf(p), code, body);
  }

  @RequirePermission('sales:work')
  @Post('prospects/:code/contacts')
  @HttpCode(200)
  addContact(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(saveContactRequestSchema)) body: SaveContactRequest,
    @CurrentPrincipal() p: Principal,
  ): Promise<ProspectDetail> {
    return this.work.saveContact(scopeOf(p), code, null, body);
  }

  @RequirePermission('sales:work')
  @Post('prospects/:code/contacts/:id/update')
  @HttpCode(200)
  updateContact(
    @Param('code', CODE) code: string,
    @Param('id', UUID) id: string,
    @Body(new ZodValidationPipe(saveContactRequestSchema)) body: SaveContactRequest,
    @CurrentPrincipal() p: Principal,
  ): Promise<ProspectDetail> {
    return this.work.saveContact(scopeOf(p), code, id, body);
  }

  @RequirePermission('sales:work')
  @Post('prospects/:code/contacts/:id/retire')
  @HttpCode(200)
  retireContact(
    @Param('code', CODE) code: string,
    @Param('id', UUID) id: string,
    @Body(new ZodValidationPipe(retireContactRequestSchema)) body: RetireContactRequest,
    @CurrentPrincipal() p: Principal,
  ): Promise<ProspectDetail> {
    return this.work.retireContact(scopeOf(p), code, id, body);
  }

  @RequirePermission('sales:work')
  @Post('prospects/:code/activities')
  @HttpCode(200)
  recordActivity(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(recordActivityRequestSchema)) body: RecordActivityRequest,
    @CurrentPrincipal() p: Principal,
  ): Promise<ProspectDetail> {
    return this.work.recordActivity(scopeOf(p), code, body);
  }

  @RequirePermission('sales:work')
  @Post('prospects/:code/activities/:id/correct')
  @HttpCode(200)
  correctActivity(
    @Param('code', CODE) code: string,
    @Param('id', UUID) id: string,
    @Body(new ZodValidationPipe(correctActivityRequestSchema)) body: CorrectActivityRequest,
    @CurrentPrincipal() p: Principal,
  ): Promise<ProspectDetail> {
    return this.work.correctActivity(scopeOf(p), code, id, body);
  }

  @RequirePermission('sales:work')
  @Post('prospects/:code/tasks')
  @HttpCode(200)
  createTask(
    @Param('code', CODE) code: string,
    @Body(new ZodValidationPipe(createTaskRequestSchema)) body: CreateTaskRequest,
    @CurrentPrincipal() p: Principal,
  ): Promise<ProspectDetail> {
    return this.work.createTask(scopeOf(p), code, body);
  }

  @RequirePermission('sales:work')
  @Get('tasks')
  tasks(
    @Query(new ZodValidationPipe(taskListQuerySchema)) query: TaskListQuery,
    @CurrentPrincipal() p: Principal,
  ): Promise<TaskPage> {
    return this.work.listTasks(scopeOf(p), query);
  }

  @RequirePermission('sales:work')
  @Post('tasks/:id/update')
  @HttpCode(200)
  updateTask(
    @Param('id', UUID) id: string,
    @Body(new ZodValidationPipe(updateTaskRequestSchema)) body: UpdateTaskRequest,
    @CurrentPrincipal() p: Principal,
  ): Promise<ProspectDetail> {
    return this.work.updateTask(scopeOf(p), id, body);
  }

  @RequirePermission('sales:work')
  @Post('tasks/:id/reschedule')
  @HttpCode(200)
  reschedule(
    @Param('id', UUID) id: string,
    @Body(new ZodValidationPipe(rescheduleTaskRequestSchema)) body: RescheduleTaskRequest,
    @CurrentPrincipal() p: Principal,
  ): Promise<ProspectDetail> {
    return this.work.rescheduleTask(scopeOf(p), id, body);
  }

  @RequirePermission('sales:work')
  @Post('tasks/:id/done')
  @HttpCode(200)
  done(
    @Param('id', UUID) id: string,
    @Body(new ZodValidationPipe(completeTaskRequestSchema)) body: CompleteTaskRequest,
    @CurrentPrincipal() p: Principal,
  ): Promise<ProspectDetail> {
    return this.work.completeTask(scopeOf(p), id, body);
  }

  @RequirePermission('sales:work')
  @Post('tasks/:id/cancel')
  @HttpCode(200)
  cancel(
    @Param('id', UUID) id: string,
    @Body(new ZodValidationPipe(cancelTaskRequestSchema)) body: CancelTaskRequest,
    @CurrentPrincipal() p: Principal,
  ): Promise<ProspectDetail> {
    return this.work.cancelTask(scopeOf(p), id, body);
  }

  @RequirePermission('sales:work', 'sales:manage')
  @Get('salespeople')
  salespeople(): Promise<Salesperson[]> {
    return this.prospects.salespeople();
  }
}
