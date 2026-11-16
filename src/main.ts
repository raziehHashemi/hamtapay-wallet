import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp, setupSwagger } from './app.setup';
import { AppConfig } from './config/app-config';

async function bootstrap(): Promise<void> {
  const config = new AppConfig(process.env); // fail fast on invalid configuration
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true, // payout webhook signatures are computed over the exact bytes
    logger: new ConsoleLogger({ json: process.env.LOG_FORMAT === 'json', timestamp: true }),
  });
  configureApp(app);
  setupSwagger(app);
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
  Logger.log(`listening on :${config.port} (workers ${config.workersEnabled ? 'on' : 'off'})`, 'Bootstrap');
}

void bootstrap();
