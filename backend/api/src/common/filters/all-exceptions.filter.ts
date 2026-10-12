import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@digisoft/db';
import type { Request, Response } from 'express';
import type { ApiFailure, ErrorCode } from '@digisoft/shared';
import { AppError } from '../errors/app-error';
import { MissingTenantContextError } from '@digisoft/db';

interface NormalisedError {
  status: number;
  code: ErrorCode;
  message: string;
  details?: unknown;
  logAsError: boolean;
}

/** The request path without its query string: a callback's ?code=&state= must never reach a log line. */
function pathOf(request: Request): string {
  return (request.originalUrl ?? request.url ?? '').split('?')[0] ?? '';
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly isProduction: boolean) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const normalised = this.normalise(exception);

    if (normalised.logAsError) {
      this.logger.error(
        `${request.method} ${pathOf(request)} -> ${normalised.status} ${normalised.code}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ApiFailure = {
      success: false,
      error: {
        code: normalised.code,
        message: normalised.message,
        ...(normalised.details !== undefined ? { details: normalised.details } : {}),
      },
    };

    response.status(normalised.status).json(body);
  }

  private normalise(exception: unknown): NormalisedError {
    if (exception instanceof AppError) {
      const payload = exception.getResponse() as { details?: unknown };
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        details: payload?.details,
        logAsError: exception.getStatus() >= 500,
      };
    }

    if (exception instanceof MissingTenantContextError) {
      // A programming error: never leak the reason to the caller.
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        logAsError: true,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.fromPrisma(exception);
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status === HttpStatus.TOO_MANY_REQUESTS) {
        // The framework's own wording leaks its class name; say something a user can act on.
        return {
          status,
          code: 'RATE_LIMITED',
          message: 'Too many requests. Wait a moment and try again.',
          logAsError: false,
        };
      }
      const res = exception.getResponse();
      const message =
        typeof res === 'string'
          ? res
          : ((res as { message?: string | string[] }).message as string) || exception.message;
      return {
        status,
        code: this.codeForStatus(status),
        message: Array.isArray(message) ? message.join(', ') : message,
        logAsError: status >= 500,
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: this.isProduction
        ? 'Internal server error'
        : exception instanceof Error
          ? exception.message
          : 'Internal server error',
      logAsError: true,
    };
  }

  private fromPrisma(error: Prisma.PrismaClientKnownRequestError): NormalisedError {
    switch (error.code) {
      // Record required by the operation was not found — includes cross-tenant writes,
      // which the tenant extension turns into a miss rather than a permission error.
      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          code: 'NOT_FOUND',
          message: 'Resource not found',
          logAsError: false,
        };
      case 'P2002':
        return {
          status: HttpStatus.CONFLICT,
          code: 'CONFLICT',
          message: 'A record with these values already exists',
          details: this.isProduction ? undefined : error.meta,
          logAsError: false,
        };
      case 'P2003':
        return {
          status: HttpStatus.BAD_REQUEST,
          code: 'VALIDATION_ERROR',
          message: 'Referenced record does not exist',
          logAsError: false,
        };
      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
          logAsError: true,
        };
    }
  }

  private codeForStatus(status: number): ErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'VALIDATION_ERROR';
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHENTICATED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.CONFLICT:
        return 'CONFLICT';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'RATE_LIMITED';
      case HttpStatus.PAYLOAD_TOO_LARGE:
        return 'FILE_TOO_LARGE';
      case HttpStatus.UNSUPPORTED_MEDIA_TYPE:
        return 'UNSUPPORTED_MEDIA_TYPE';
      default:
        return 'INTERNAL_ERROR';
    }
  }
}
