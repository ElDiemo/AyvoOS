import { createHash } from 'node:crypto';
import {
  GetBucketEncryptionCommand,
  GetBucketOwnershipControlsCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetPublicAccessBlockCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { Env } from '../config/env.js';
import {
  STORAGE_KEY_PATTERN,
  StorageObjectAlreadyExistsError,
  StorageObjectNotFoundError,
  StorageUnavailableError,
  type FileStorage,
} from './file-storage.js';

export interface S3StorageConfig {
  bucket: string;
  region: string;
  expectedBucketOwner: string;
}

const DEADLINE_MS = 30_000;

/**
 * Private AWS S3 storage (ADR 0032). The public interface still has no delete or signed URL.
 * Tests inject an SDK client with a synthetic transport, never production credentials.
 */
export class S3FileStorage implements FileStorage {
  constructor(
    private readonly config: S3StorageConfig,
    private readonly client: S3Client,
  ) {}

  /** Read-only boot gate: fail closed before serving requests if the bucket is not protected. */
  async verifyConfiguration(): Promise<void> {
    const target = this.target();
    const options = { abortSignal: AbortSignal.timeout(DEADLINE_MS) };
    try {
      // HeadBucket returns the actual bucket region, without the legacy GetBucketLocation
      // response aliases. Never follow a redirect to a differently configured region.
      const head = await this.client.send(new HeadBucketCommand(target), options);
      const versioning = await this.client.send(new GetBucketVersioningCommand(target), options);
      const publicAccess = await this.client.send(new GetPublicAccessBlockCommand(target), options);
      const ownership = await this.client.send(
        new GetBucketOwnershipControlsCommand(target),
        options,
      );
      const encryption = await this.client.send(new GetBucketEncryptionCommand(target), options);
      const block = publicAccess.PublicAccessBlockConfiguration;
      const encryptionRules = encryption.ServerSideEncryptionConfiguration?.Rules;
      if (
        head.BucketRegion !== this.config.region ||
        versioning.Status !== 'Enabled' ||
        block?.BlockPublicAcls !== true ||
        block.IgnorePublicAcls !== true ||
        block.BlockPublicPolicy !== true ||
        block.RestrictPublicBuckets !== true ||
        !ownership.OwnershipControls?.Rules?.some(
          (r) => r.ObjectOwnership === 'BucketOwnerEnforced',
        ) ||
        encryptionRules?.length !== 1 ||
        encryptionRules[0]?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm !== 'AES256'
      ) {
        throw new StorageUnavailableError();
      }
    } catch {
      // Do not propagate an SDK exception or include it as a cause in application logs.
      throw new StorageUnavailableError();
    }
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    this.validateKey(key);
    // Snapshot caller-owned bytes so later mutation cannot change what the checksum describes.
    const body = Buffer.from(data);
    const digest = createHash('sha256').update(body).digest();
    try {
      await this.client.send(
        new PutObjectCommand({
          ...this.target(),
          Key: key,
          Body: body,
          IfNoneMatch: '*',
          ServerSideEncryption: 'AES256',
          ContentType: 'application/octet-stream',
          ContentLength: body.length,
          ChecksumSHA256: digest.toString('base64'),
          Metadata: { sha256: digest.toString('hex') },
        }),
        { abortSignal: AbortSignal.timeout(DEADLINE_MS) },
      );
    } catch (error) {
      if (httpStatus(error) === 412) throw new StorageObjectAlreadyExistsError();
      // A 409, timeout or lost response is not success. Never retry without the condition or
      // "verify" an uncertain write by treating a later collision as a successful new write.
      throw new StorageUnavailableError();
    }
  }

  async get(key: string): Promise<Buffer> {
    this.validateKey(key);
    let response;
    try {
      response = await this.client.send(
        new GetObjectCommand({
          ...this.target(),
          Key: key,
        }),
        { abortSignal: AbortSignal.timeout(DEADLINE_MS) },
      );
    } catch (error) {
      // Only the object-level NoSuchKey is a missing file. 403, NoSuchBucket, network and auth
      // errors must remain failures, not a misleading 404 that could hide a broken restore.
      if (httpStatus(error) === 404 && errorName(error) === 'NoSuchKey') {
        throw new StorageObjectNotFoundError();
      }
      throw new StorageUnavailableError();
    }
    try {
      if (!response.Body) throw new StorageUnavailableError();
      const bytes = Buffer.from(await response.Body.transformToByteArray());
      const expectedHash = response.Metadata?.sha256;
      if (
        !expectedHash ||
        !/^[a-f0-9]{64}$/.test(expectedHash) ||
        createHash('sha256').update(bytes).digest('hex') !== expectedHash
      ) {
        throw new StorageUnavailableError();
      }
      return bytes;
    } catch {
      throw new StorageUnavailableError();
    }
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  private target() {
    return { Bucket: this.config.bucket, ExpectedBucketOwner: this.config.expectedBucketOwner };
  }

  private validateKey(key: string): void {
    if (!STORAGE_KEY_PATTERN.test(key)) throw new Error('Invalid storage key');
  }
}

/** No endpoint override, ambient profile or instance-metadata credential lookup. */
export async function createS3FileStorage(env: Env): Promise<S3FileStorage> {
  if (
    env.APP_ENV !== 'production' ||
    env.FILE_STORAGE_DRIVER !== 's3' ||
    !env.AWS_REGION ||
    !env.AWS_ACCESS_KEY_ID ||
    !env.AWS_SECRET_ACCESS_KEY ||
    !env.S3_BUCKET ||
    !env.S3_EXPECTED_BUCKET_OWNER
  ) {
    throw new StorageUnavailableError();
  }
  const client = new S3Client({
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
    // One attempt: a conditional write whose response was lost remains an unknown outcome.
    maxAttempts: 1,
    ignoreConfiguredEndpointUrls: true,
    followRegionRedirects: false,
    requestHandler: new NodeHttpHandler({ connectionTimeout: 3_000, socketTimeout: 15_000 }),
  });
  const storage = new S3FileStorage(
    {
      bucket: env.S3_BUCKET,
      region: env.AWS_REGION,
      expectedBucketOwner: env.S3_EXPECTED_BUCKET_OWNER,
    },
    client,
  );
  try {
    await storage.verifyConfiguration();
    return storage;
  } catch (error) {
    client.destroy();
    throw error;
  }
}

function httpStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
}

function errorName(error: unknown): string | undefined {
  return (error as { name?: string } | null)?.name;
}
