/**
 * Unit Tests: Background Workers
 * Tests submission worker, polling worker, and batch sync scheduler
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { HCMSubmissionWorker } from '../../src/workers/submission.worker';
import { HCMPollingWorker } from '../../src/workers/polling.worker';
import { BatchSyncScheduler } from '../../src/workers/batch-sync.scheduler';
import { RequestService } from '../../src/services/request.service';
import { BalanceService } from '../../src/services/balance.service';
import { HCMSyncService } from '../../src/services/hcm-sync.service';

// Setup helper: create in-memory DB with schema
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  const schema = fs.readFileSync(path.join(__dirname, '../../src/database/schema.sql'), 'utf-8');
  db.exec(schema);
  return db;
}

// Setup helper: seed a balance
function seedBalance(db: Database.Database, employeeId: string, locationId: string, balanceType: string, balance: number, version = 1) {
  const id = require('crypto').randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO balances (id, employee_id, location_id, balance_type, current_balance, hcm_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, employeeId, locationId, balanceType, balance, version, now, now);
}

// Setup helper: seed a request in processing status without HCM submission
function seedProcessingRequest(db: Database.Database, id: string, employeeId: string, locationId: string, balanceType: string, days: number) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO requests (id, employee_id, location_id, balance_type, days_requested, requested_balance_at_submission, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'processing', ?, ?)`
  ).run(id, employeeId, locationId, balanceType, days, 20, now, now);
}

// Setup helper: seed a request submitted to HCM
function seedSubmittedRequest(db: Database.Database, id: string, employeeId: string, locationId: string, balanceType: string, days: number, submissionId: string, submittedAt?: string) {
  const now = submittedAt || new Date().toISOString();
  db.prepare(
    `INSERT INTO requests (id, employee_id, location_id, balance_type, days_requested, requested_balance_at_submission, status, hcm_submission_id, submitted_to_hcm_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?)`
  ).run(id, employeeId, locationId, balanceType, days, 20, submissionId, now, now, now);
}

// Mock HTTP server helper
function createMockServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, () => {
      const addr = server.address() as any;
      resolve({ server, port: addr.port });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ===== HCMSubmissionWorker =====

describe('HCMSubmissionWorker', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  test('should submit unsubmitted processing requests to HCM', async () => {
    seedBalance(db, 'E001', 'NYC', 'vacation', 20);
    seedProcessingRequest(db, 'REQ-1', 'E001', 'NYC', 'vacation', 5);

    const { server, port } = await createMockServer((req, res) => {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ submissionId: 'SUB-100', status: 'received', createdAt: new Date().toISOString() }));
      });
    });

    try {
      const balanceService = new BalanceService(db);
      const requestService = new RequestService(db, balanceService);
      const hcmSync = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
      const worker = new HCMSubmissionWorker(db, requestService, hcmSync);

      const result = await worker.tick();
      expect(result.submitted).toBe(1);
      expect(result.failed).toBe(0);

      // Verify HCM submission was recorded
      const req = db.prepare(`SELECT hcm_submission_id FROM requests WHERE id = ?`).get('REQ-1') as any;
      expect(req.hcm_submission_id).toBe('SUB-100');
    } finally {
      await closeServer(server);
    }
  });

  test('should skip requests already submitted to HCM', async () => {
    seedBalance(db, 'E001', 'NYC', 'vacation', 20);
    seedSubmittedRequest(db, 'REQ-1', 'E001', 'NYC', 'vacation', 5, 'SUB-EXISTING');

    const balanceService = new BalanceService(db);
    const requestService = new RequestService(db, balanceService);
    const hcmSync = new HCMSyncService(db, balanceService, 'http://localhost:19999', 1000, 1);
    const worker = new HCMSubmissionWorker(db, requestService, hcmSync);

    const result = await worker.tick();
    expect(result.submitted).toBe(0);
    expect(result.failed).toBe(0);
  });

  test('should handle HCM submission failure gracefully', async () => {
    seedBalance(db, 'E001', 'NYC', 'vacation', 20);
    seedProcessingRequest(db, 'REQ-1', 'E001', 'NYC', 'vacation', 5);

    const { server, port } = await createMockServer((req, res) => {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        res.writeHead(500);
        res.end('Server Error');
      });
    });

    try {
      const balanceService = new BalanceService(db);
      const requestService = new RequestService(db, balanceService);
      const hcmSync = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
      const worker = new HCMSubmissionWorker(db, requestService, hcmSync);

      const result = await worker.tick();
      expect(result.submitted).toBe(0);
      expect(result.failed).toBe(1);

      // Request should still have no submission ID
      const req = db.prepare(`SELECT hcm_submission_id FROM requests WHERE id = ?`).get('REQ-1') as any;
      expect(req.hcm_submission_id).toBeNull();
    } finally {
      await closeServer(server);
    }
  });

  test('should start and stop interval', () => {
    const balanceService = new BalanceService(db);
    const requestService = new RequestService(db, balanceService);
    const hcmSync = new HCMSyncService(db, balanceService, 'http://localhost:19999', 1000, 1);
    const worker = new HCMSubmissionWorker(db, requestService, hcmSync, 60000);

    expect(worker.isRunning()).toBe(false);
    worker.start();
    expect(worker.isRunning()).toBe(true);
    worker.stop();
    expect(worker.isRunning()).toBe(false);
  });
});

// ===== HCMPollingWorker =====

describe('HCMPollingWorker', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  test('should mark request as approved when HCM says approved', async () => {
    seedBalance(db, 'E001', 'NYC', 'vacation', 20);
    seedSubmittedRequest(db, 'REQ-1', 'E001', 'NYC', 'vacation', 5, 'SUB-1');

    const { server, port } = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'approved' }));
    });

    try {
      const balanceService = new BalanceService(db);
      const requestService = new RequestService(db, balanceService);
      const hcmSync = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
      const worker = new HCMPollingWorker(db, requestService, hcmSync, balanceService);

      const result = await worker.tick();
      expect(result.approved).toBe(1);
      expect(result.rejected).toBe(0);

      // Verify request status
      const req = db.prepare(`SELECT status FROM requests WHERE id = ?`).get('REQ-1') as any;
      expect(req.status).toBe('approved');

      // Verify balance was deducted
      const bal = db.prepare(`SELECT current_balance FROM balances WHERE employee_id = ? AND location_id = ?`).get('E001', 'NYC') as any;
      expect(bal.current_balance).toBe(15); // 20 - 5
    } finally {
      await closeServer(server);
    }
  });

  test('should mark request as rejected when HCM says rejected', async () => {
    seedBalance(db, 'E001', 'NYC', 'vacation', 20);
    seedSubmittedRequest(db, 'REQ-1', 'E001', 'NYC', 'vacation', 5, 'SUB-1');

    const { server, port } = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'rejected' }));
    });

    try {
      const balanceService = new BalanceService(db);
      const requestService = new RequestService(db, balanceService);
      const hcmSync = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
      const worker = new HCMPollingWorker(db, requestService, hcmSync, balanceService);

      const result = await worker.tick();
      expect(result.rejected).toBe(1);

      const req = db.prepare(`SELECT status FROM requests WHERE id = ?`).get('REQ-1') as any;
      expect(req.status).toBe('rejected');

      // Balance should NOT be deducted
      const bal = db.prepare(`SELECT current_balance FROM balances WHERE employee_id = ? AND location_id = ?`).get('E001', 'NYC') as any;
      expect(bal.current_balance).toBe(20);
    } finally {
      await closeServer(server);
    }
  });

  test('should keep polling when HCM says processing', async () => {
    seedBalance(db, 'E001', 'NYC', 'vacation', 20);
    seedSubmittedRequest(db, 'REQ-1', 'E001', 'NYC', 'vacation', 5, 'SUB-1');

    const { server, port } = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'processing' }));
    });

    try {
      const balanceService = new BalanceService(db);
      const requestService = new RequestService(db, balanceService);
      const hcmSync = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
      const worker = new HCMPollingWorker(db, requestService, hcmSync, balanceService);

      const result = await worker.tick();
      expect(result.stillProcessing).toBe(1);
      expect(result.approved).toBe(0);

      // Request should still be processing
      const req = db.prepare(`SELECT status FROM requests WHERE id = ?`).get('REQ-1') as any;
      expect(req.status).toBe('processing');
    } finally {
      await closeServer(server);
    }
  });

  test('should time out requests that exceed max polling duration', async () => {
    seedBalance(db, 'E001', 'NYC', 'vacation', 20);
    // Submitted 2 hours ago
    const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    seedSubmittedRequest(db, 'REQ-1', 'E001', 'NYC', 'vacation', 5, 'SUB-1', oldTime);

    const balanceService = new BalanceService(db);
    const requestService = new RequestService(db, balanceService);
    const hcmSync = new HCMSyncService(db, balanceService, 'http://localhost:19999', 1000, 1);
    // Max polling: 1 hour
    const worker = new HCMPollingWorker(db, requestService, hcmSync, balanceService, 5000, 60 * 60 * 1000);

    const result = await worker.tick();
    expect(result.timedOut).toBe(1);
    expect(result.approved).toBe(0);

    // Request should still be processing (timeout just logs, doesn't reject)
    const req = db.prepare(`SELECT status FROM requests WHERE id = ?`).get('REQ-1') as any;
    expect(req.status).toBe('processing');

    // Audit log should record the timeout
    const auditLog = db.prepare(
      `SELECT * FROM audit_logs WHERE event_type = 'polling_timeout' AND entity_id = ?`
    ).get('REQ-1') as any;
    expect(auditLog).toBeDefined();
  });

  test('should start and stop interval', () => {
    const balanceService = new BalanceService(db);
    const requestService = new RequestService(db, balanceService);
    const hcmSync = new HCMSyncService(db, balanceService, 'http://localhost:19999', 1000, 1);
    const worker = new HCMPollingWorker(db, requestService, hcmSync, balanceService, 60000);

    expect(worker.isRunning()).toBe(false);
    worker.start();
    expect(worker.isRunning()).toBe(true);
    worker.stop();
    expect(worker.isRunning()).toBe(false);
  });
});

// ===== BatchSyncScheduler =====

describe('BatchSyncScheduler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  test('should run batch sync and update balances', async () => {
    const { server, port } = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        balances: [
          { employeeId: 'E001', locationId: 'NYC', balanceType: 'vacation', balance: 25, hcmVersion: 3 },
          { employeeId: 'E001', locationId: 'NYC', balanceType: 'sick', balance: 12, hcmVersion: 3 },
        ]
      }));
    });

    try {
      const balanceService = new BalanceService(db);
      const requestService = new RequestService(db, balanceService);
      const hcmSync = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
      const scheduler = new BatchSyncScheduler(db, hcmSync, requestService);

      const result = await scheduler.runBatchSync();
      expect(result.success).toBe(true);
      expect(result.updatedCount).toBe(2);

      // Verify balances stored
      const bal = db.prepare(
        `SELECT current_balance FROM balances WHERE employee_id = ? AND location_id = ? AND balance_type = ?`
      ).get('E001', 'NYC', 'vacation') as any;
      expect(bal.current_balance).toBe(25);
    } finally {
      await closeServer(server);
    }
  });

  test('should recover stuck requests that HCM approved', async () => {
    seedBalance(db, 'E001', 'NYC', 'vacation', 20);
    // Submitted 25 hours ago
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    seedSubmittedRequest(db, 'REQ-STUCK', 'E001', 'NYC', 'vacation', 5, 'SUB-STUCK', oldTime);

    const { server, port } = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'approved' }));
    });

    try {
      const balanceService = new BalanceService(db);
      const requestService = new RequestService(db, balanceService);
      const hcmSync = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
      const scheduler = new BatchSyncScheduler(db, hcmSync, requestService, 60000, 60000, 24 * 60 * 60 * 1000);

      const result = await scheduler.recoverStuckRequests();
      expect(result.recovered).toBe(1);
      expect(result.rejected).toBe(0);

      const req = db.prepare(`SELECT status FROM requests WHERE id = ?`).get('REQ-STUCK') as any;
      expect(req.status).toBe('approved');
    } finally {
      await closeServer(server);
    }
  });

  test('should auto-reject requests still processing after 24+ hours', async () => {
    seedBalance(db, 'E001', 'NYC', 'vacation', 20);
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    seedSubmittedRequest(db, 'REQ-STUCK', 'E001', 'NYC', 'vacation', 5, 'SUB-STUCK', oldTime);

    const { server, port } = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'processing' })); // Still processing
    });

    try {
      const balanceService = new BalanceService(db);
      const requestService = new RequestService(db, balanceService);
      const hcmSync = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
      const scheduler = new BatchSyncScheduler(db, hcmSync, requestService, 60000, 60000, 24 * 60 * 60 * 1000);

      const result = await scheduler.recoverStuckRequests();
      expect(result.recovered).toBe(0);
      expect(result.rejected).toBe(1);

      const req = db.prepare(`SELECT status, manager_reason FROM requests WHERE id = ?`).get('REQ-STUCK') as any;
      expect(req.status).toBe('rejected');
      expect(req.manager_reason).toContain('stuck in processing');
    } finally {
      await closeServer(server);
    }
  });

  test('should not touch requests within threshold', async () => {
    seedBalance(db, 'E001', 'NYC', 'vacation', 20);
    // Submitted just now — not stuck
    seedSubmittedRequest(db, 'REQ-RECENT', 'E001', 'NYC', 'vacation', 5, 'SUB-RECENT');

    const balanceService = new BalanceService(db);
    const requestService = new RequestService(db, balanceService);
    const hcmSync = new HCMSyncService(db, balanceService, 'http://localhost:19999', 1000, 1);
    const scheduler = new BatchSyncScheduler(db, hcmSync, requestService, 60000, 60000, 24 * 60 * 60 * 1000);

    const result = await scheduler.recoverStuckRequests();
    expect(result.recovered).toBe(0);
    expect(result.rejected).toBe(0);

    // Request should be unchanged
    const req = db.prepare(`SELECT status FROM requests WHERE id = ?`).get('REQ-RECENT') as any;
    expect(req.status).toBe('processing');
  });

  test('should start and stop scheduler', () => {
    const balanceService = new BalanceService(db);
    const requestService = new RequestService(db, balanceService);
    const hcmSync = new HCMSyncService(db, balanceService, 'http://localhost:19999', 1000, 1);
    const scheduler = new BatchSyncScheduler(db, hcmSync, requestService, 60000, 60000);

    expect(scheduler.isRunning()).toBe(false);
    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });

  test('should handle batchSync error gracefully', async () => {
    const balanceService = new BalanceService(db);
    const requestService = new RequestService(db, balanceService);
    const hcmSync = new HCMSyncService(db, balanceService, 'http://localhost:19999', 100, 1);
    const scheduler = new BatchSyncScheduler(db, hcmSync, requestService);

    // Force batchSync to throw (not just return failure)
    jest.spyOn(hcmSync, 'batchSync').mockRejectedValue(new Error('Network catastrophe'));

    const result = await scheduler.runBatchSync();
    expect(result.success).toBe(false);
    expect(result.failedLocations).toContain('all');

    // Verify audit log was created for failure
    const audit = db.prepare("SELECT * FROM audit_logs WHERE event_type = 'batch_sync_failed'").get() as any;
    expect(audit).toBeDefined();

    jest.restoreAllMocks();
  });

  test('should recover stuck request rejected by HCM', async () => {
    seedBalance(db, 'E001', 'NYC', 'vacation', 20);
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    seedSubmittedRequest(db, 'REQ-REJ', 'E001', 'NYC', 'vacation', 5, 'SUB-REJ', oldTime);

    const { server, port } = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'rejected' }));
    });

    try {
      const balanceService = new BalanceService(db);
      const requestService = new RequestService(db, balanceService);
      const hcmSync = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
      const scheduler = new BatchSyncScheduler(db, hcmSync, requestService, 60000, 60000, 24 * 60 * 60 * 1000);

      const result = await scheduler.recoverStuckRequests();
      expect(result.recovered).toBe(1);
      expect(result.rejected).toBe(0);

      const req = db.prepare('SELECT status, manager_reason FROM requests WHERE id = ?').get('REQ-REJ') as any;
      expect(req.status).toBe('rejected');
      expect(req.manager_reason).toContain('Rejected by HCM');
    } finally {
      await closeServer(server);
    }
  });

  test('should handle per-request recovery error gracefully', async () => {
    seedBalance(db, 'E001', 'NYC', 'vacation', 20);
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    seedSubmittedRequest(db, 'REQ-ERR', 'E001', 'NYC', 'vacation', 5, 'SUB-ERR', oldTime);

    const balanceService = new BalanceService(db);
    const requestService = new RequestService(db, balanceService);
    // Mock hcmSyncService.pollStatus to throw
    const hcmSync = new HCMSyncService(db, balanceService, 'http://localhost:19999', 100, 1);
    jest.spyOn(hcmSync, 'pollStatus').mockRejectedValue(new Error('Simulated HCM failure'));

    const scheduler = new BatchSyncScheduler(db, hcmSync, requestService, 60000, 60000, 24 * 60 * 60 * 1000);

    // Should not throw — error is caught per-request
    const result = await scheduler.recoverStuckRequests();
    expect(result.recovered).toBe(0);
    expect(result.rejected).toBe(0);

    jest.restoreAllMocks();
  });

  test('should invalidate cache when deducting balance directly', async () => {
    seedBalance(db, 'E_CACHE', 'NYC', 'vacation', 20);
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    seedSubmittedRequest(db, 'REQ-CACHE', 'E_CACHE', 'NYC', 'vacation', 5, 'SUB-CACHE', oldTime);

    const { server, port } = await createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'approved' }));
    });

    const mockCache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      delPattern: jest.fn().mockResolvedValue(undefined),
      healthCheck: jest.fn().mockResolvedValue(true),
      connect: jest.fn(),
      disconnect: jest.fn(),
    } as any;

    try {
      const balanceService = new BalanceService(db);
      const requestService = new RequestService(db, balanceService);
      const hcmSync = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
      const scheduler = new BatchSyncScheduler(db, hcmSync, requestService, 60000, 60000, 24 * 60 * 60 * 1000, mockCache);

      const result = await scheduler.recoverStuckRequests();
      expect(result.recovered).toBe(1);
      // Cache should have been invalidated
      expect(mockCache.del).toHaveBeenCalledWith('balance:E_CACHE:NYC:vacation');
      expect(mockCache.del).toHaveBeenCalledWith('balances:employee:E_CACHE');
    } finally {
      await closeServer(server);
    }
  });

  test('should not start twice', () => {
    const balanceService = new BalanceService(db);
    const requestService = new RequestService(db, balanceService);
    const hcmSync = new HCMSyncService(db, balanceService, 'http://localhost:19999', 1000, 1);
    const scheduler = new BatchSyncScheduler(db, hcmSync, requestService, 60000, 60000);

    scheduler.start();
    const firstIntervalRunning = scheduler.isRunning();
    scheduler.start(); // Should be no-op
    expect(scheduler.isRunning()).toBe(firstIntervalRunning);
    scheduler.stop();
  });
});

// ===== HCMSubmissionWorker — additional coverage =====

describe('HCMSubmissionWorker — edge cases', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  test('should handle outer tick error (db query fails)', async () => {
    const balanceService = new BalanceService(db);
    const requestService = new RequestService(db, balanceService);
    const hcmSync = new HCMSyncService(db, balanceService, 'http://localhost:19999', 1000, 1);
    const worker = new HCMSubmissionWorker(db, requestService, hcmSync);

    // Mock db.prepare to throw on the SELECT query
    const origPrepare = db.prepare.bind(db);
    jest.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('hcm_submission_id IS NULL')) {
        throw new Error('Simulated DB error');
      }
      return origPrepare(sql);
    });

    // Should not throw — error is caught
    const result = await worker.tick();
    expect(result.submitted).toBe(0);
    expect(result.failed).toBe(0);

    jest.restoreAllMocks();
  });

  test('should not run tick concurrently', async () => {
    seedBalance(db, 'E001', 'NYC', 'vacation', 20);
    seedProcessingRequest(db, 'REQ-CONC', 'E001', 'NYC', 'vacation', 5);

    const { server, port } = await createMockServer((req, res) => {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        // Slow response
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ submissionId: 'SUB-SLOW', status: 'received', createdAt: new Date().toISOString() }));
        }, 100);
      });
    });

    try {
      const balanceService = new BalanceService(db);
      const requestService = new RequestService(db, balanceService);
      const hcmSync = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
      const worker = new HCMSubmissionWorker(db, requestService, hcmSync);

      // Start two ticks concurrently — second should return early
      const [result1, result2] = await Promise.all([worker.tick(), worker.tick()]);
      // One should submit, the other should be skipped
      expect(result1.submitted + result2.submitted).toBe(1);
    } finally {
      await closeServer(server);
    }
  });

  test('should not start twice', () => {
    const balanceService = new BalanceService(db);
    const requestService = new RequestService(db, balanceService);
    const hcmSync = new HCMSyncService(db, balanceService, 'http://localhost:19999', 1000, 1);
    const worker = new HCMSubmissionWorker(db, requestService, hcmSync, 60000);

    worker.start();
    expect(worker.isRunning()).toBe(true);
    worker.start(); // no-op
    expect(worker.isRunning()).toBe(true);
    worker.stop();
  });
});

// ===== HCMPollingWorker — additional coverage =====

describe('HCMPollingWorker — edge cases', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  test('should handle per-request polling error gracefully', async () => {
    seedBalance(db, 'E001', 'NYC', 'vacation', 20);
    seedSubmittedRequest(db, 'REQ-POLLERR', 'E001', 'NYC', 'vacation', 5, 'SUB-POLLERR');

    // HCM returns error for polling
    const { server, port } = await createMockServer((req, res) => {
      res.writeHead(404);
      res.end('Not Found');
    });

    try {
      const balanceService = new BalanceService(db);
      const requestService = new RequestService(db, balanceService);
      const hcmSync = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
      const worker = new HCMPollingWorker(db, requestService, hcmSync, balanceService);

      // pollStatus catches errors and returns 'processing'
      const result = await worker.tick();
      expect(result.stillProcessing).toBe(1);
    } finally {
      await closeServer(server);
    }
  });

  test('should handle outer tick error (db query fails)', async () => {
    const balanceService = new BalanceService(db);
    const requestService = new RequestService(db, balanceService);
    const hcmSync = new HCMSyncService(db, balanceService, 'http://localhost:19999', 1000, 1);
    const worker = new HCMPollingWorker(db, requestService, hcmSync, balanceService);

    const origPrepare = db.prepare.bind(db);
    jest.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('hcm_submission_id IS NOT NULL')) {
        throw new Error('Simulated DB error');
      }
      return origPrepare(sql);
    });

    const result = await worker.tick();
    expect(result.approved).toBe(0);

    jest.restoreAllMocks();
  });
});
