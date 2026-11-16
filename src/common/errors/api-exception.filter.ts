import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { DomainError } from './domain-error';
import { ErrorCode } from './error-codes';

/** Renders every error as the contract shape `{ code, message }`. Internals are never leaked. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.toHttp(exception);
    if (status >= 500) {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }
    response.status(status).json(body);
  }

  private toHttp(exception: unknown): { status: number; body: { code: string; message: string } } {
    if (exception instanceof DomainError) {
      return { status: exception.httpStatus, body: exception.toBody() };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return { status, body: { code: this.codeFor(status), message: this.messageOf(exception) } };
    }
    // body-parser errors (malformed JSON, payload too large) are plain errors carrying a status
    const statusLike = (exception as { status?: unknown })?.status;
    if (typeof statusLike === 'number' && statusLike >= 400 && statusLike < 500) {
      const message = statusLike === 400 ? 'request body is not valid JSON' : 'request rejected';
      return { status: statusLike, body: { code: this.codeFor(statusLike), message } };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { code: ErrorCode.INTERNAL_ERROR, message: 'unexpected error' },
    };
  }

  private codeFor(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ErrorCode.VALIDATION_ERROR;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      case HttpStatus.UNAUTHORIZED:
      case HttpStatus.FORBIDDEN:
        return ErrorCode.UNAUTHORIZED;
      default:
        return status >= 500 ? ErrorCode.INTERNAL_ERROR : 'HTTP_' + status;
    }
  }

  private messageOf(exception: HttpException): string {
    const response = exception.getResponse();
    if (typeof response === 'string') return response;
    const message = (response as { message?: unknown }).message;
    if (Array.isArray(message)) return message.join('; ');
    return typeof message === 'string' ? message : exception.message;
  }
}
