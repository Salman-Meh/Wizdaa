/**
 * Global HTTP Exception Filter
 * Transforms exceptions into standardized error responses
 */

import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let details: any = null;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'object') {
        message = (exceptionResponse as any).message || exception.message;
        details = (exceptionResponse as any).details;
      } else {
        message = exceptionResponse as string;
      }
    } else if (exception instanceof Error) {
      message = exception.message;

      // Map specific error types
      if (exception.message.includes('Insufficient balance')) {
        status = HttpStatus.BAD_REQUEST;
      } else if (exception.message.includes('not found')) {
        status = HttpStatus.NOT_FOUND;
      } else if (exception.message.includes('Unauthorized')) {
        status = HttpStatus.FORBIDDEN;
      } else if (exception.message.includes('Version mismatch')) {
        status = HttpStatus.CONFLICT;
      }
    } else {
      message = String(exception);
    }

    // Log the error
    this.logger.error(
      `${request.method} ${request.url}`,
      {
        status,
        message,
        details,
        stack: exception instanceof Error ? exception.stack : undefined
      }
    );

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      message,
      details
    });
  }
}
