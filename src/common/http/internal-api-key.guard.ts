import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { AppConfig } from '../../config/app-config';
import { Errors } from '../errors/domain-error';

/**
 * Protects operations endpoints (`/internal/*`, `/reconciliation/*`). Enabled when INTERNAL_API_KEY is set;
 * in production these routes should additionally be reachable only from the ops network.
 */
@Injectable()
export class InternalApiKeyGuard implements CanActivate {
  constructor(private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.internalApiKey;
    if (!expected) return true;
    const provided = context.switchToHttp().getRequest<Request>().header('x-internal-api-key') ?? '';
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw Errors.unauthorized();
    return true;
  }
}
