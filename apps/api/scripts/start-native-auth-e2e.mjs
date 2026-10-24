// Dedicated native-auth browser fixture: no fake identity endpoint and no external email.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
const apiRoot = resolve(import.meta.dirname, '..');
const webRoot = resolve(apiRoot, '../web');
const { PrismaPg } = await import('@prisma/adapter-pg');
const { PrismaClient } = await import(resolve(apiRoot, 'dist/generated/prisma/client.js'));
const { PrismaService } = await import(resolve(apiRoot, 'dist/database/prisma.service.js'));
const { loadEnv } = await import(resolve(apiRoot, 'dist/config/env.js'));
const { AuditService } = await import(resolve(apiRoot, 'dist/audit/audit.service.js'));
const { NativeSecretBox } = await import(resolve(apiRoot, 'dist/identity/native-credentials.js'));
const { NativeTokensService } = await import(
  resolve(apiRoot, 'dist/identity/native-tokens.service.js')
);
const { LocalInvitationsProvider } = await import(
  resolve(apiRoot, 'dist/identity/local-invitations.provider.js')
);
const { InvitationsService } = await import(
  resolve(apiRoot, 'dist/identity/invitations.service.js')
);
const { bootstrapFirstAdmin } = await import(resolve(apiRoot, 'dist/identity/bootstrap.js'));
const serverUrl = process.env.NATIVE_E2E_DATABASE_URL;
if (!serverUrl || !['localhost', '127.0.0.1'].includes(new URL(serverUrl).hostname))
  throw new Error('Explicit loopback TEST database required');
const name = `ayvo_native_e2e_${randomBytes(6).toString('hex')}`;
const databaseUrl = new URL(serverUrl);
databaseUrl.pathname = `/${name}`;
const adminUrl = new URL(serverUrl);
adminUrl.pathname = '/postgres';
const admin = new PrismaClient({
  adapter: new PrismaPg({ connectionString: adminUrl.toString() }),
});
await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
const storage = await mkdtemp(resolve(tmpdir(), 'ayvo-native-ui-storage-'));
const fixtureFile = resolve(webRoot, 'native-e2e', '.fixture.json');
/** Drops exactly this run's database and files, also when the preparation itself failed. */
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {
    console.error(`Could not drop the native e2e database ${name}; drop it by hand.`);
  });
  await admin.$disconnect();
  await unlink(fixtureFile).catch(() => undefined);
  await rm(storage, { recursive: true, force: true });
}
let source;
try {
  execFileSync(resolve(apiRoot, 'node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
    stdio: 'inherit',
  });
  source = {
    APP_ENV: 'test',
    AUTH_PROVIDER: 'local',
    AUTH_MAIL_DRIVER: 'memory',
    AUTH_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    DATABASE_URL: databaseUrl.toString(),
    REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    APP_PUBLIC_ORIGIN: 'http://localhost:3210',
    PUBLIC_QR_BASE_URL: 'http://localhost:3210/q',
    FILE_STORAGE_DIR: storage,
    PRINT_SWEEP_SECONDS: '0',
    SUPPLY_PLAN_SECONDS: '0',
    AUTH_RATE_LIMIT_LOGIN_MAX: '100000',
    AUTH_RATE_LIMIT_CALLBACK_FAILURES_MAX: '100000',
    API_PORT: '4210',
  };
  const env = loadEnv(source);
  const prisma = new PrismaService(env);
  const email = 'native-ui-admin@ayvo.test';
  const boot = await bootstrapFirstAdmin(prisma, { email, displayName: 'Native UI Admin' });
  if (!boot.ok) throw new Error('Native e2e bootstrap failed');
  const mail = new NativeTokensService(prisma, env, new NativeSecretBox(env.AUTH_ENCRYPTION_KEY));
  const invites = new InvitationsService(
    prisma,
    new AuditService(prisma),
    new LocalInvitationsProvider(prisma, mail),
  );
  await invites.send(null, boot.userId, randomUUID(), 'Synthetic native browser fixture');
  await mail.deliverPending();
  const delivery = mail.deliveriesForTest().find((entry) => entry.to === email);
  if (!delivery) throw new Error('Native e2e mail fixture failed');
  await mkdir(resolve(webRoot, 'native-e2e'), { recursive: true });
  await writeFile(fixtureFile, JSON.stringify({ email, activationUrl: delivery.url }), {
    mode: 0o600,
  });
  mail.onModuleDestroy();
  await prisma.$disconnect();
} catch (error) {
  await cleanup();
  throw error;
}
const child = spawn(process.execPath, ['dist/main.js'], {
  cwd: apiRoot,
  stdio: 'inherit',
  env: { ...process.env, ...source },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', async (error) => {
  await cleanup();
  console.error(error);
  process.exit(1);
});
child.on('exit', async (code) => {
  await cleanup();
  process.exit(code ?? 0);
});
