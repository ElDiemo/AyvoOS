import { Logger, type ArgumentsHost } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  StorageObjectAlreadyExistsError,
  StorageObjectNotFoundError,
  StorageUnavailableError,
} from './file-storage.js';
import { StorageErrorFilter } from './storage-error.filter.js';

afterEach(() => vi.restoreAllMocks());

describe('StorageErrorFilter', () => {
  it.each([
    [new StorageObjectNotFoundError(), 404, 'The stored file is not available'],
    [new StorageObjectAlreadyExistsError(), 409, 'Stored file already exists'],
    [new StorageUnavailableError(), 503, 'File storage is unavailable'],
  ])('returns only a stable safe response for %s', (error, expectedStatus, expectedMessage) => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', url: '/api/admin/file' }),
        getResponse: () => ({ status }),
      }),
    } as unknown as ArgumentsHost;
    new StorageErrorFilter().catch(error, host);
    expect(status).toHaveBeenCalledWith(expectedStatus);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: expectedStatus, message: expectedMessage }),
    );
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(json.mock.calls)).not.toContain('stack');
  });
});
