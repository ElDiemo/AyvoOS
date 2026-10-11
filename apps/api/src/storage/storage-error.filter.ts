import {
  Catch,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { StorageObjectNotFoundError } from './file-storage.js';

/**
 * A database record points at a stored file that is missing (lost volume, failed restore).
 * Clients get a stable, safe 404; the details (never paths) go to the server log only.
 */
@Catch(StorageObjectNotFoundError)
export class StorageErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(StorageErrorFilter.name);

  catch(_error: StorageObjectNotFoundError, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<{ method: string; url: string }>();
    this.logger.error(`Stored file missing for ${request.method} ${request.url}`);
    http
      .getResponse<{ status(code: number): { json(body: unknown): void } }>()
      .status(HttpStatus.NOT_FOUND)
      .json({
        statusCode: HttpStatus.NOT_FOUND,
        error: 'Not Found',
        message: 'The stored file is not available',
      });
  }
}
