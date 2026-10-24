import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  HeadBucketCommand,
  GetBucketOwnershipControlsCommand,
  GetBucketEncryptionCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../config/env.js';
import { PRODUCTION_QR_BASE_URL } from '../common/qr-policy.js';
import {
  newStorageKey,
  StorageObjectAlreadyExistsError,
  StorageObjectNotFoundError,
  StorageUnavailableError,
} from './file-storage.js';
import { createS3FileStorage, S3FileStorage } from './s3-file-storage.js';

type Request = Parameters<NodeHttpHandler['handle']>[0];
const config = {
  bucket: 'ayvo-test-files',
  region: 'eu-north-1',
  expectedBucketOwner: '123456789012',
};
const clients: S3Client[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Real AWS SDK serialization/signing + a synthetic in-memory HTTP transport, no live network. */
function fixture() {
  const objects = new Map<string, { bytes: Buffer; hash: string }>();
  const requests: Request[] = [];
  const settings = {
    region: 'eu-north-1',
    versioning: '<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>',
    publicAccessBlock:
      '<PublicAccessBlockConfiguration><BlockPublicAcls>true</BlockPublicAcls><IgnorePublicAcls>true</IgnorePublicAcls><BlockPublicPolicy>true</BlockPublicPolicy><RestrictPublicBuckets>true</RestrictPublicBuckets></PublicAccessBlockConfiguration>',
    ownershipControls:
      '<OwnershipControls><Rule><ObjectOwnership>BucketOwnerEnforced</ObjectOwnership></Rule></OwnershipControls>',
    encryption:
      '<ServerSideEncryptionConfiguration><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>AES256</SSEAlgorithm></ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>',
  };
  const reply = (statusCode: number, body = '', headers: Record<string, string> = {}) => ({
    response: { statusCode, headers, body: Readable.from([Buffer.from(body)]) },
  });
  const fail = (status: number, code: string) =>
    reply(
      status,
      `<Error><Code>${code}</Code><Message>synthetic private request details</Message></Error>`,
    );
  let override: ((request: Request) => ReturnType<typeof reply> | undefined) | undefined;
  const handle = vi.fn(async (request: Request) => {
    requests.push(request);
    const custom = override?.(request);
    if (custom) return custom;
    // Expected-owner is part of EVERY request, including reads and the boot gate.
    expect(request.headers['x-amz-expected-bucket-owner']).toBe(config.expectedBucketOwner);
    expect(request.protocol).toBe('https:');
    expect(request.hostname).toBe(`${config.bucket}.s3.${config.region}.amazonaws.com`);
    expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    if (request.method === 'HEAD')
      return reply(200, '', { 'x-amz-bucket-region': settings.region });
    if ('versioning' in (request.query ?? {})) return reply(200, settings.versioning);
    if ('publicAccessBlock' in (request.query ?? {})) return reply(200, settings.publicAccessBlock);
    if ('ownershipControls' in (request.query ?? {})) return reply(200, settings.ownershipControls);
    if ('encryption' in (request.query ?? {})) return reply(200, settings.encryption);
    const key = decodeURIComponent(request.path.replace(/^\//, ''));
    if (request.method === 'PUT') {
      // Match S3's atomic conditional semantics, including concurrent writes.
      expect(request.headers['x-amz-server-side-encryption']).toBe('AES256');
      expect(request.headers['x-amz-acl']).toBeUndefined();
      if (request.headers['if-none-match'] === '*' && objects.has(key)) {
        return fail(412, 'PreconditionFailed');
      }
      const bytes = Buffer.from(request.body as Uint8Array);
      expect(request.headers['x-amz-checksum-sha256']).toBe(
        createHash('sha256').update(bytes).digest('base64'),
      );
      objects.set(key, { bytes, hash: request.headers['x-amz-meta-sha256']! });
      return reply(200);
    }
    const object = objects.get(key);
    if (!object) return fail(404, 'NoSuchKey');
    return {
      response: {
        statusCode: 200,
        headers: { 'x-amz-meta-sha256': object.hash },
        body: Readable.from([object.bytes]),
      },
    };
  });
  const client = new S3Client({
    region: config.region,
    credentials: { accessKeyId: 'AKIAFAKE000000000000', secretAccessKey: 'fake-secret-only' },
    maxAttempts: 1,
    ignoreConfiguredEndpointUrls: true,
    requestHandler: { handle, destroy: vi.fn() },
  });
  clients.push(client);
  return {
    storage: new S3FileStorage(config, client),
    client,
    objects,
    requests,
    settings,
    handle,
    override(fn: typeof override) {
      override = fn;
    },
    fail,
  };
}

describe('S3FileStorage (real SDK, synthetic HTTP only)', () => {
  it('checks the owner, region, versioning, public access, ACLs and encryption without writes', async () => {
    const f = fixture();
    const target = { Bucket: config.bucket, ExpectedBucketOwner: config.expectedBucketOwner };
    // Verify wire fixtures with the real SDK; a malformed fixture must not make every
    // negative boot-gate test pass just because every response is rejected.
    await expect(f.client.send(new HeadBucketCommand(target))).resolves.toMatchObject({
      BucketRegion: config.region,
    });
    await expect(f.client.send(new GetBucketVersioningCommand(target))).resolves.toMatchObject({
      Status: 'Enabled',
    });
    await expect(f.client.send(new GetPublicAccessBlockCommand(target))).resolves.toMatchObject({
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    });
    await expect(
      f.client.send(new GetBucketOwnershipControlsCommand(target)),
    ).resolves.toMatchObject({
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
    });
    await expect(f.client.send(new GetBucketEncryptionCommand(target))).resolves.toMatchObject({
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
    });
    f.requests.length = 0;
    await f.storage.verifyConfiguration();
    expect(f.requests).toHaveLength(5);
    expect(f.requests.every((r) => ['HEAD', 'GET'].includes(r.method))).toBe(true);
    expect(f.objects.size).toBe(0);
  });

  it.each([
    ['region', 'eu-west-1'],
    ['versioning', '<VersioningConfiguration><Status>Suspended</Status></VersioningConfiguration>'],
    ['versioning', '<VersioningConfiguration/>'],
    [
      'publicAccessBlock',
      '<PublicAccessBlockConfiguration><BlockPublicAcls>false</BlockPublicAcls><IgnorePublicAcls>true</IgnorePublicAcls><BlockPublicPolicy>true</BlockPublicPolicy><RestrictPublicBuckets>true</RestrictPublicBuckets></PublicAccessBlockConfiguration>',
    ],
    ['publicAccessBlock', '<PublicAccessBlockConfiguration/>'],
    [
      'ownershipControls',
      '<OwnershipControls><Rule><ObjectOwnership>ObjectWriter</ObjectOwnership></Rule></OwnershipControls>',
    ],
    [
      'encryption',
      '<ServerSideEncryptionConfiguration><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>aws:kms</SSEAlgorithm></ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>',
    ],
    ['encryption', '<ServerSideEncryptionConfiguration/>'],
  ] as const)('refuses an unprotected / wrong bucket: %s', async (setting, value) => {
    const f = fixture();
    f.settings[setting] = value;
    await expect(f.storage.verifyConfiguration()).rejects.toBeInstanceOf(StorageUnavailableError);
    expect(f.objects.size).toBe(0);
  });

  it('fails closed when bucket ownership / permissions / network cannot be verified', async () => {
    const f = fixture();
    f.override(() => f.fail(403, 'AccessDenied'));
    await expect(f.storage.verifyConfiguration()).rejects.toBeInstanceOf(StorageUnavailableError);
    expect(f.requests).toHaveLength(1);
  });

  it('uploads complete bytes with conditional write, SHA-256 and SSE-S3, then reads them back', async () => {
    const f = fixture();
    const key = newStorageKey('supplier-documents', 'pdf');
    const bytes = Buffer.from([0, 1, 2, 127, 255]);
    await f.storage.put(key, bytes);
    expect(f.requests[0]!.headers['if-none-match']).toBe('*');
    expect(await f.storage.get(key)).toEqual(bytes);
    expect(f.requests.map((r) => r.method)).toEqual(['PUT', 'GET']);
  });

  it('supports a complete empty object without mistaking it for a missing body', async () => {
    const f = fixture();
    const key = newStorageKey('supplier-documents', 'pdf');
    await f.storage.put(key, Buffer.alloc(0));
    expect(await f.storage.get(key)).toEqual(Buffer.alloc(0));
  });

  it('never replaces an existing object, including two concurrent puts', async () => {
    const f = fixture();
    const key = newStorageKey('label-print-jobs', 'pdf');
    const results = await Promise.allSettled([
      f.storage.put(key, Buffer.from('first')),
      f.storage.put(key, Buffer.from('second')),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(StorageObjectAlreadyExistsError);
    expect(await f.storage.get(key)).toEqual(Buffer.from('first'));
  });

  it('takes a copy of input bytes before awaiting the SDK', async () => {
    const f = fixture();
    const key = newStorageKey('label-artworks', 'png');
    const bytes = Buffer.from('first');
    const pending = f.storage.put(key, bytes);
    bytes.fill(0);
    await pending;
    expect(await f.storage.get(key)).toEqual(Buffer.from('first'));
  });

  it('returns the safe missing-object error only for NoSuchKey, not for an absent bucket', async () => {
    const f = fixture();
    const key = newStorageKey('label-artworks', 'png');
    await expect(f.storage.get(key)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    f.override(() => f.fail(404, 'NoSuchBucket'));
    await expect(f.storage.get(key)).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it.each([403, 409, 500, 503])(
    'does not retry or expose SDK details on HTTP %s',
    async (status) => {
      const f = fixture();
      f.override(() => f.fail(status, 'SyntheticFailure'));
      const key = newStorageKey('shipment-labels', 'zpl');
      for (const operation of [
        () => f.storage.put(key, Buffer.from('ZPL')),
        () => f.storage.get(key),
      ]) {
        f.handle.mockClear();
        const error = await operation().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(StorageUnavailableError);
        expect(String(error)).toBe('Error: File storage is unavailable');
        expect(error).not.toHaveProperty('cause');
        expect(f.handle).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('does not call a lost upload response a success or silently overwrite on retry', async () => {
    const f = fixture();
    const key = newStorageKey('shipment-labels', 'zpl');
    f.handle.mockImplementationOnce(async () => {
      f.objects.set(key, {
        bytes: Buffer.from('first'),
        hash: createHash('sha256').update('first').digest('hex'),
      });
      throw new Error('synthetic timeout with private request data');
    });
    await expect(f.storage.put(key, Buffer.from('first'))).rejects.toBeInstanceOf(
      StorageUnavailableError,
    );
    expect(f.handle).toHaveBeenCalledTimes(1);
    await expect(f.storage.put(key, Buffer.from('second'))).rejects.toBeInstanceOf(
      StorageObjectAlreadyExistsError,
    );
    expect(await f.storage.get(key)).toEqual(Buffer.from('first'));
  });

  it('detects corrupted bytes / missing integrity metadata', async () => {
    const f = fixture();
    const key = newStorageKey('label-artworks', 'png');
    await f.storage.put(key, Buffer.from('first'));
    f.objects.get(key)!.bytes = Buffer.from('changed');
    await expect(f.storage.get(key)).rejects.toBeInstanceOf(StorageUnavailableError);
    f.objects.get(key)!.hash = '';
    await expect(f.storage.get(key)).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it.each([
    '../etc/passwd',
    '/absolute/file.pdf',
    'supplier-documents/2026/10/bad.pdf',
    'https://other.example/file',
  ])('rejects unsafe key %s before any request', async (key) => {
    const f = fixture();
    await expect(f.storage.put(key, Buffer.from('x'))).rejects.toThrow('Invalid storage key');
    await expect(f.storage.get(key)).rejects.toThrow('Invalid storage key');
    expect(f.handle).not.toHaveBeenCalled();
  });

  it('refuses the S3 factory in development / tests even with stray AWS credentials', async () => {
    const env = loadEnv({
      APP_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@localhost/test',
      REDIS_URL: 'redis://localhost:6379',
    });
    await expect(createS3FileStorage(env)).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it('the production factory verifies the bucket, ignores ambient endpoints and signs only with its explicit key', async () => {
    const f = fixture();
    vi.stubEnv('AWS_ENDPOINT_URL', 'http://must-not-be-used.invalid');
    vi.stubEnv('AWS_ENDPOINT_URL_S3', 'http://must-not-be-used.invalid');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'DIFFERENT_AMBIENT_KEY');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'different-ambient-secret');
    vi.spyOn(NodeHttpHandler.prototype, 'handle').mockImplementation(f.handle);
    const env = loadEnv({
      APP_ENV: 'production',
      DATABASE_URL: 'postgresql://test:test@localhost/test',
      REDIS_URL: 'redis://localhost:6379',
      AUTH_ENCRYPTION_KEY: '5f0c9a3e7b2d48e1a6c4f9073d8b2e51c7a09f6e3b4d2c8a1f7e605b9d3c4a28', // synthetic test value
      AUTH_SMTP_HOST: 'smtp.example.test',
      AUTH_SMTP_USER: 'synthetic-user',
      AUTH_SMTP_PASSWORD: 'synthetic-password',
      AUTH_MAIL_FROM: 'noreply@ayvo.test',
      APP_PUBLIC_ORIGIN: 'https://app.example',
      PUBLIC_QR_BASE_URL: PRODUCTION_QR_BASE_URL,
      LABEL_QR_MIN_SIZE_MM: '15',
      LABEL_QR_ERROR_CORRECTION: 'Q',
      FILE_STORAGE_DRIVER: 's3',
      AWS_REGION: config.region,
      AWS_ACCESS_KEY_ID: 'AKIAFAKE000000000000',
      AWS_SECRET_ACCESS_KEY: 'fakeOnlySecret',
      S3_BUCKET: config.bucket,
      S3_EXPECTED_BUCKET_OWNER: config.expectedBucketOwner,
    });
    const storage = await createS3FileStorage(env);
    try {
      expect(f.requests).toHaveLength(5);
      for (const request of f.requests) {
        expect(request.headers.authorization).toContain('Credential=AKIAFAKE000000000000/');
        expect(request.headers.authorization).not.toContain('AMBIENT');
      }
      f.override(() => f.fail(403, 'AccessDenied'));
      const destroy = vi.spyOn(NodeHttpHandler.prototype, 'destroy');
      await expect(createS3FileStorage(env)).rejects.toBeInstanceOf(StorageUnavailableError);
      expect(destroy).toHaveBeenCalledOnce();
    } finally {
      storage.onModuleDestroy();
    }
  });

  it('destroys the SDK client on application shutdown', () => {
    const f = fixture();
    const destroy = vi.spyOn(f.client, 'destroy');
    f.storage.onModuleDestroy();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
