import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { configureApp } from '../app.setup.js';
import { FinanceAppModule } from './finance-app.module.js';
import { FINANCE_ENV, type FinanceEnv } from './finance-env.js';

// The Finance unit's entry point (ADR 0039): `node dist/finance/main.js`. Local development reads
// the repository-level .env; deployed environments inject the Finance env only.
const envFile = resolve(process.cwd(), '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const app = configureApp(await NestFactory.create(FinanceAppModule));
app.enableShutdownHooks();
await app.listen(app.get<FinanceEnv>(FINANCE_ENV).FINANCE_PORT);
