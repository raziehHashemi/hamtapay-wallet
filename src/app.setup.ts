import { INestApplication, Logger, ValidationError, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ApiExceptionFilter } from './common/errors/api-exception.filter';
import { Errors } from './common/errors/domain-error';

function firstMessage(errors: ValidationError[]): string {
  for (const error of errors) {
    const constraint = error.constraints && Object.values(error.constraints)[0];
    if (constraint) return constraint;
    if (error.children?.length) return firstMessage(error.children);
  }
  return 'request is invalid';
}

/** Shared by main.ts and the test harness so tests exercise exactly the production HTTP pipeline. */
export function configureApp(app: INestApplication): void {
  const access = new Logger('HTTP');
  const express = app.getHttpAdapter().getInstance() as { disable?: (s: string) => void; set?: (k: string, v: unknown) => void };
  express.disable?.('x-powered-by');
  express.set?.('trust proxy', true);

  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = (req.header('x-request-id') ?? '').slice(0, 100) || randomUUID();
    res.setHeader('X-Request-Id', requestId);
    const started = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/health')) return;
      access.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms rid=${requestId}`);
    });
    next();
  });

  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      exceptionFactory: (errors) => Errors.validation(firstMessage(errors)),
    }),
  );
}

export function setupSwagger(app: INestApplication): void {
  const document = SwaggerModule.createDocument(app, buildOpenApiConfig());
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs-json', yamlDocumentUrl: 'docs-yaml' });
}

export function buildOpenApiConfig() {
  return new DocumentBuilder()
    .setTitle('HamtaPay Wallet & Ledger Service')
    .setDescription(
      'Wallet and double-entry ledger for IRT (Toman) and USDT. All amounts are strings: IRT integer Toman, ' +
        'USDT up to 6 decimals. Every money-moving POST (except webhooks and /reconciliation/run) requires an ' +
        '`Idempotency-Key` header. Errors are `{ "code": "...", "message": "..." }`.',
    )
    .setVersion('1.0.0')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Internal-Api-Key' }, 'internal-api-key')
    .build();
}
