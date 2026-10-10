import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { ENV, type Env } from './config/env.js';

// Local development reads the repository-level .env; deployed environments inject real env vars.
const envFile = resolve(process.cwd(), '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

async function bootstrap(): Promise<void> {
  const app = configureApp(await NestFactory.create(AppModule));
  app.enableShutdownHooks();
  const env = app.get<Env>(ENV);
  await app.listen(env.API_PORT);
}

await bootstrap();
