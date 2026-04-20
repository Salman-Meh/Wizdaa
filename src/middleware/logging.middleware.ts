/**
 * Request Logging Middleware
 * Logs incoming requests and response times
 */

import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class LoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction) {
    const startTime = Date.now();
    const { method, originalUrl, ip } = req;

    // Log request
    this.logger.log(`[${method}] ${originalUrl} - IP: ${ip}`);

    // Capture response
    const originalSend = res.send;
    const logger = this.logger;
    res.send = function (data: any) {
      const duration = Date.now() - startTime;
      const statusCode = res.statusCode;

      logger.log(
        `[${method}] ${originalUrl} - Status: ${statusCode} - Duration: ${duration}ms`
      );

      return originalSend.call(this, data);
    };

    next();
  }
}
