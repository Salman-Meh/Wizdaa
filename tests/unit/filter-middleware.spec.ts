import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { GlobalExceptionFilter } from '../../src/filters/global-exception.filter';
import { LoggingMiddleware } from '../../src/middleware/logging.middleware';

// Suppress logger output during tests
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

function createMockHost(req: Partial<Request>, res: any) {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as any;
}

function createMockResponse() {
  const jsonFn = jest.fn();
  const statusFn = jest.fn().mockReturnValue({ json: jsonFn });
  return { status: statusFn, json: jsonFn };
}

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;
  const baseRequest = { method: 'POST', url: '/api/time-off/requests' };

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
  });

  it('should handle HttpException with object response (message + details)', () => {
    const res = createMockResponse();
    const host = createMockHost(baseRequest, res);
    const exception = new HttpException(
      { message: 'Validation failed', details: { field: 'startDate' } },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );

    filter.catch(exception, host);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(res.status(0).json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        message: 'Validation failed',
        details: { field: 'startDate' },
        path: '/api/time-off/requests',
        method: 'POST',
      }),
    );
  });

  it('should handle HttpException with string response', () => {
    const res = createMockResponse();
    const host = createMockHost(baseRequest, res);
    const exception = new HttpException('Not allowed', HttpStatus.FORBIDDEN);

    filter.catch(exception, host);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    expect(res.status(0).json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.FORBIDDEN,
        message: 'Not allowed',
        details: null,
      }),
    );
  });

  it('should map "Insufficient balance" error to 400', () => {
    const res = createMockResponse();
    const host = createMockHost(baseRequest, res);

    filter.catch(new Error('Insufficient balance for this request'), host);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(res.status(0).json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Insufficient balance for this request',
      }),
    );
  });

  it('should map "not found" error to 404', () => {
    const res = createMockResponse();
    const host = createMockHost(baseRequest, res);

    filter.catch(new Error('Employee not found'), host);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
  });

  it('should map "Unauthorized" error to 403', () => {
    const res = createMockResponse();
    const host = createMockHost(baseRequest, res);

    filter.catch(new Error('Unauthorized access'), host);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
  });

  it('should map "Version mismatch" error to 409', () => {
    const res = createMockResponse();
    const host = createMockHost(baseRequest, res);

    filter.catch(new Error('Version mismatch detected'), host);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
  });

  it('should map generic Error to 500', () => {
    const res = createMockResponse();
    const host = createMockHost(baseRequest, res);

    filter.catch(new Error('Something unexpected'), host);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(res.status(0).json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Something unexpected',
      }),
    );
  });

  it('should handle non-Error exception (string thrown) as 500', () => {
    const res = createMockResponse();
    const host = createMockHost(baseRequest, res);

    filter.catch('raw string error', host);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(res.status(0).json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'raw string error',
        details: null,
      }),
    );
  });

  it('should include timestamp and path in every response', () => {
    const res = createMockResponse();
    const host = createMockHost(baseRequest, res);

    filter.catch(new Error('any'), host);

    const body = res.status(0).json.mock.calls[0][0];
    expect(body.timestamp).toBeDefined();
    expect(new Date(body.timestamp).getTime()).not.toBeNaN();
    expect(body.path).toBe('/api/time-off/requests');
    expect(body.method).toBe('POST');
  });
});

describe('LoggingMiddleware', () => {
  let middleware: LoggingMiddleware;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    middleware = new LoggingMiddleware();
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('should log the incoming request on entry', () => {
    const req = { method: 'GET', originalUrl: '/api/balances', ip: '127.0.0.1' } as any;
    const res = { send: jest.fn(), statusCode: 200 } as any;
    const next = jest.fn();

    middleware.use(req, res, next);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('[GET] /api/balances - IP: 127.0.0.1'),
    );
  });

  it('should log response with status code and duration on send', () => {
    const req = { method: 'POST', originalUrl: '/api/requests', ip: '10.0.0.1' } as any;
    const originalSend = jest.fn().mockReturnThis();
    const res = { send: originalSend, statusCode: 201 } as any;
    const next = jest.fn();

    middleware.use(req, res, next);

    // Trigger the wrapped send
    res.send('{"ok":true}');

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[POST\] \/api\/requests - Status: 201 - Duration: \d+ms/),
    );
  });

  it('should call next() to pass control', () => {
    const req = { method: 'GET', originalUrl: '/', ip: '::1' } as any;
    const res = { send: jest.fn(), statusCode: 200 } as any;
    const next = jest.fn();

    middleware.use(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
