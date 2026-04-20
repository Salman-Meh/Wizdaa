/**
 * Additional coverage tests for BalanceService, RequestService, and HCMSyncService.
 * Targets specific uncovered lines identified in the coverage report.
 */

import * as http from 'http';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { BalanceService } from '../../src/services/balance.service';
import { RequestService } from '../../src/services/request.service';
import { HCMSyncService } from '../../src/services/hcm-sync.service';
import { RedisCacheService } from '../../src/services/redis-cache.service';
import { Balance } from '../../src/models/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS balances (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      balance_type TEXT NOT NULL,
      current_balance REAL NOT NULL DEFAULT 0,
      hcm_version INTEGER NOT NULL DEFAULT 1,
      last_synced_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(employee_id, location_id, balance_type)
    );

    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      balance_type TEXT NOT NULL,
      days_requested REAL NOT NULL,
      requested_balance_at_submission REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_manager_approval',
      manager_id TEXT,
      manager_location_id TEXT,
      manager_action_at TEXT,
      manager_reason TEXT,
      hcm_submission_id TEXT,
      submitted_to_hcm_at TEXT,
      hcm_approved_at TEXT,
      divergence_detected_at TEXT,
      divergence_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor TEXT,
      details TEXT,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

function seedBalance(
  db: Database.Database,
  overrides: Partial<{
    id: string;
    employeeId: string;
    locationId: string;
    balanceType: string;
    currentBalance: number;
    hcmVersion: number;
  }> = {}
) {
  const id = overrides.id ?? uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO balances (id, employee_id, location_id, balance_type, current_balance, hcm_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    overrides.employeeId ?? 'E001',
    overrides.locationId ?? 'NYC',
    overrides.balanceType ?? 'vacation',
    overrides.currentBalance ?? 10,
    overrides.hcmVersion ?? 1,
    now,
    now
  );
  return id;
}

/** Create a lightweight mock HTTP server */
function createMockServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ server: http.Server; port: number }> {
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

// ---------------------------------------------------------------------------
// BalanceService — cache paths & edge cases
// ---------------------------------------------------------------------------

describe('BalanceService — cache and edge-case coverage', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // --- Lines 29-35: getBalance cache hit path ---

  describe('getBalance with cache hit', () => {
    test('should return cached balance and restore Date objects', async () => {
      const now = new Date();
      const cached: Balance = {
        id: 'bal-cached',
        employeeId: 'E001',
        locationId: 'NYC',
        balanceType: 'vacation',
        currentBalance: 42,
        hcmVersion: 3,
        lastSyncedAt: now,
        createdAt: now,
        updatedAt: now,
      };

      const mockCache = {
        get: jest.fn().mockResolvedValue(JSON.parse(JSON.stringify(cached))),
        set: jest.fn().mockResolvedValue(undefined),
        del: jest.fn().mockResolvedValue(undefined),
      } as unknown as RedisCacheService;

      const service = new BalanceService(db, mockCache);
      const result = await service.getBalance('E001', 'NYC', 'vacation');

      expect(result.id).toBe('bal-cached');
      expect(result.currentBalance).toBe(42);
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.updatedAt).toBeInstanceOf(Date);
      expect(result.lastSyncedAt).toBeInstanceOf(Date);
      expect(mockCache.get).toHaveBeenCalledWith('balance:E001:NYC:vacation');
    });

    test('should return cached balance without lastSyncedAt', async () => {
      const now = new Date();
      const cached: any = {
        id: 'bal-cached-2',
        employeeId: 'E001',
        locationId: 'NYC',
        balanceType: 'vacation',
        currentBalance: 10,
        hcmVersion: 1,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        // no lastSyncedAt
      };

      const mockCache = {
        get: jest.fn().mockResolvedValue(cached),
        set: jest.fn().mockResolvedValue(undefined),
        del: jest.fn().mockResolvedValue(undefined),
      } as unknown as RedisCacheService;

      const service = new BalanceService(db, mockCache);
      const result = await service.getBalance('E001', 'NYC', 'vacation');

      expect(result.lastSyncedAt).toBeUndefined();
    });
  });

  // --- Line 109: deductBalance balance not found ---

  describe('deductBalance — balance not found', () => {
    test('should throw when no balance exists', async () => {
      const service = new BalanceService(db);

      await expect(
        service.deductBalance('NONEXIST', 'NYC', 'vacation', 1, 1)
      ).rejects.toThrow('Balance not found for NONEXIST at NYC');
    });
  });

  // --- Line 137: deductBalance concurrent modification (changes === 0) ---

  describe('deductBalance — concurrent modification after version check', () => {
    test('should throw on version mismatch (wrong expectedVersion)', async () => {
      seedBalance(db, { employeeId: 'E010', currentBalance: 20, hcmVersion: 5 });
      const service = new BalanceService(db);

      await expect(
        service.deductBalance('E010', 'NYC', 'vacation', 1, 3)
      ).rejects.toThrow('Version mismatch');
    });
  });

  // --- Lines 215-216: batchUpdateBalances error path ---

  describe('batchUpdateBalances — insert failure path', () => {
    test('should count failures when an update throws', async () => {
      const service = new BalanceService(db);

      // Remove the unique constraint table and recreate without the right columns
      // to trigger an error inside the per-update try/catch (line 214-216).
      // We'll spy on db.prepare to throw on the inner SELECT for the first item.
      const origPrepare = db.prepare.bind(db);
      let selectCallCount = 0;
      jest.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        // The batchUpdateBalances first prepares the INSERT OR UPDATE,
        // then inside the loop prepares a SELECT to check existing.
        // We want the inner SELECT to fail.
        if (sql.includes('SELECT id FROM balances') && sql.includes('WHERE employee_id')) {
          selectCallCount++;
          if (selectCallCount === 1) {
            throw new Error('Simulated prepare failure');
          }
        }
        return origPrepare(sql);
      });

      const result = await service.batchUpdateBalances([
        { employeeId: 'E001', locationId: 'NYC', balanceType: 'vacation', balance: 10, version: 1 },
        { employeeId: 'E002', locationId: 'LA', balanceType: 'sick', balance: 5, version: 1 },
      ]);

      jest.restoreAllMocks();

      expect(result.failedCount).toBeGreaterThanOrEqual(1);
      expect(result.success).toBe(false);
    });
  });

  // --- Lines 281-287: updateLastSyncedAt ---

  describe('updateLastSyncedAt', () => {
    test('should update last_synced_at without error', async () => {
      seedBalance(db, { employeeId: 'E020', locationId: 'LA', balanceType: 'sick' });
      const service = new BalanceService(db);

      await expect(
        service.updateLastSyncedAt('E020', 'LA', 'sick')
      ).resolves.toBeUndefined();

      // Verify the column was actually set
      const row = db
        .prepare(
          `SELECT last_synced_at FROM balances WHERE employee_id = ? AND location_id = ? AND balance_type = ?`
        )
        .get('E020', 'LA', 'sick') as any;

      expect(row.last_synced_at).toBeTruthy();
    });

    test('should be a no-op when balance does not exist (0 rows affected)', async () => {
      const service = new BalanceService(db);
      // No balance seeded — should not throw
      await expect(
        service.updateLastSyncedAt('GHOST', 'NOWHERE', 'vacation')
      ).resolves.toBeUndefined();
    });
  });

  // --- Lines 297-299: getAllBalancesForEmployee cache hit ---

  describe('getAllBalancesForEmployee — cache hit', () => {
    test('should return cached array with restored dates', async () => {
      const now = new Date();
      const cachedArray = [
        {
          id: 'b1',
          employeeId: 'E001',
          locationId: 'NYC',
          balanceType: 'vacation',
          currentBalance: 10,
          hcmVersion: 1,
          lastSyncedAt: now.toISOString(),
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
        {
          id: 'b2',
          employeeId: 'E001',
          locationId: 'LA',
          balanceType: 'sick',
          currentBalance: 5,
          hcmVersion: 2,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          // no lastSyncedAt
        },
      ];

      const mockCache = {
        get: jest.fn().mockResolvedValue(cachedArray),
        set: jest.fn().mockResolvedValue(undefined),
        del: jest.fn().mockResolvedValue(undefined),
      } as unknown as RedisCacheService;

      const service = new BalanceService(db, mockCache);
      const result = await service.getAllBalancesForEmployee('E001');

      expect(result).toHaveLength(2);
      expect(result[0].createdAt).toBeInstanceOf(Date);
      expect(result[0].lastSyncedAt).toBeInstanceOf(Date);
      expect(result[1].lastSyncedAt).toBeUndefined();
      expect(mockCache.get).toHaveBeenCalledWith('balances:employee:E001');
    });
  });

  // --- Lines 338-339: invalidateBalanceCache ---

  describe('invalidateBalanceCache', () => {
    test('should call cache.del for both keys', async () => {
      const mockCache = {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
        del: jest.fn().mockResolvedValue(undefined),
      } as unknown as RedisCacheService;

      const service = new BalanceService(db, mockCache);
      await service.invalidateBalanceCache('E001', 'NYC', 'vacation');

      expect(mockCache.del).toHaveBeenCalledWith('balance:E001:NYC:vacation');
      expect(mockCache.del).toHaveBeenCalledWith('balances:employee:E001');
    });

    test('should be a no-op when no cache is configured', async () => {
      const service = new BalanceService(db); // no cache
      // Should not throw
      await expect(service.invalidateBalanceCache('E001', 'NYC', 'vacation')).resolves.toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// RequestService — uncovered branches
// ---------------------------------------------------------------------------

describe('RequestService — branch coverage', () => {
  let db: Database.Database;
  let balanceService: BalanceService;
  let requestService: RequestService;

  beforeEach(() => {
    db = createTestDb();
    balanceService = new BalanceService(db);
    requestService = new RequestService(db, balanceService);
  });

  afterEach(() => {
    db.close();
  });

  // Helper: create a request in a given status
  async function createRequestInStatus(
    status: string,
    employeeId = 'E001',
    locationId = 'NYC'
  ): Promise<string> {
    seedBalance(db, { employeeId, locationId, currentBalance: 20 });
    const req = await requestService.submitRequest({
      employeeId,
      locationId,
      balanceType: 'vacation',
      daysRequested: 3,
    });
    if (status !== 'pending_manager_approval') {
      db.prepare(`UPDATE requests SET status = ? WHERE id = ?`).run(status, req.id);
    }
    return req.id;
  }

  // --- Line 152: confirmRequest — request not found ---

  describe('confirmRequest — request not found', () => {
    test('should throw for nonexistent request id', async () => {
      await expect(
        requestService.confirmRequest('nonexistent-id', 'E001', 'proceed')
      ).rejects.toThrow('not found');
    });
  });

  // --- Line 157: confirmRequest — wrong status ---

  describe('confirmRequest — wrong status', () => {
    test('should throw when request is not in pending_employee_confirmation', async () => {
      const reqId = await createRequestInStatus('pending_manager_approval');

      await expect(
        requestService.confirmRequest(reqId, 'E001', 'proceed')
      ).rejects.toThrow('Cannot confirm request in status');
    });
  });

  // --- Line 164: confirmRequest — wrong employee ---

  describe('confirmRequest — wrong employee', () => {
    test('should throw when employee does not own the request', async () => {
      const reqId = await createRequestInStatus('pending_employee_confirmation');

      await expect(
        requestService.confirmRequest(reqId, 'WRONG_EMPLOYEE', 'proceed')
      ).rejects.toThrow('Unauthorized');
    });
  });

  // --- Line 178: confirmRequest — invalid action ---

  describe('confirmRequest — invalid action', () => {
    test('should throw for an unrecognized action', async () => {
      const reqId = await createRequestInStatus('pending_employee_confirmation');

      await expect(
        requestService.confirmRequest(reqId, 'E001', 'invalid_action' as any)
      ).rejects.toThrow('Invalid action');
    });
  });

  // --- Line 198: getRequestStatus — not found ---

  describe('getRequestStatus — not found', () => {
    test('should throw when request does not exist', async () => {
      await expect(
        requestService.getRequestStatus('does-not-exist')
      ).rejects.toThrow('not found');
    });
  });

  // --- Lines 229-241: getRequestsInProcessing ---

  describe('getRequestsInProcessing', () => {
    test('should return empty array when no requests are processing', async () => {
      const result = await requestService.getRequestsInProcessing();
      expect(result).toEqual([]);
    });

    test('should return mapped request objects for processing requests', async () => {
      // Create a request and transition to processing
      seedBalance(db, { employeeId: 'E050', locationId: 'NYC', currentBalance: 20 });
      const req = await requestService.submitRequest({
        employeeId: 'E050',
        locationId: 'NYC',
        balanceType: 'vacation',
        daysRequested: 2,
      });

      // Approve it to move to processing
      const approved = await requestService.approveRequest(req.id, 'M001', 'NYC');
      expect(approved.status).toBe('processing');

      const processing = await requestService.getRequestsInProcessing();

      expect(processing).toHaveLength(1);
      expect(processing[0].id).toBe(req.id);
      expect(processing[0].employeeId).toBe('E050');
      expect(processing[0].status).toBe('processing');
      expect(processing[0].createdAt).toBeInstanceOf(Date);
      expect(processing[0].updatedAt).toBeInstanceOf(Date);
    });

    test('should not return requests in other statuses', async () => {
      seedBalance(db, { employeeId: 'E051', locationId: 'NYC', currentBalance: 20 });
      await requestService.submitRequest({
        employeeId: 'E051',
        locationId: 'NYC',
        balanceType: 'vacation',
        daysRequested: 1,
      });

      // Still in pending_manager_approval — should not appear
      const processing = await requestService.getRequestsInProcessing();
      expect(processing).toHaveLength(0);
    });
  });

  // --- Line 91: approveRequest — request not found (dead branch, but for completeness) ---

  describe('approveRequest — edge cases', () => {
    test('should throw when request does not exist', async () => {
      await expect(
        requestService.approveRequest('no-such-request', 'M001', 'NYC')
      ).rejects.toThrow('not found');
    });

    test('should throw when request is not in pending_manager_approval status', async () => {
      const reqId = await createRequestInStatus('processing');

      await expect(
        requestService.approveRequest(reqId, 'M001', 'NYC')
      ).rejects.toThrow('Cannot approve request in status');
    });
  });
});

// ---------------------------------------------------------------------------
// HCMSyncService — makeRequest edge cases
// ---------------------------------------------------------------------------

describe('HCMSyncService — makeRequest edge-case coverage', () => {
  let db: Database.Database;
  let balanceService: BalanceService;

  beforeEach(() => {
    db = createTestDb();
    balanceService = new BalanceService(db);
  });

  afterEach(() => {
    db.close();
  });

  // --- Line 232: non-JSON 200 response ---

  describe('makeRequest — non-JSON 200 response', () => {
    test('should resolve with raw string when response is not valid JSON', async () => {
      const { server, port } = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK plain text');
      });

      try {
        const service = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
        // healthCheck calls makeRequest and checks truthiness
        const healthy = await service.healthCheck();
        expect(healthy).toBe(true); // non-null truthy string resolves
      } finally {
        await closeServer(server);
      }
    });
  });

  // --- Line 235: 404 response ---

  describe('makeRequest — 404 response', () => {
    test('should reject with Not found error on 404', async () => {
      const { server, port } = await createMockServer((req, res) => {
        res.writeHead(404);
        res.end('Not Found');
      });

      try {
        const service = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
        // fetchBalance catches errors and returns null
        const result = await service.fetchBalance('E001', 'NYC');
        expect(result).toBeNull();
      } finally {
        await closeServer(server);
      }
    });

    test('should propagate 404 error through submitRequest', async () => {
      const { server, port } = await createMockServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          res.writeHead(404);
          res.end('Not Found');
        });
      });

      try {
        const service = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
        await expect(
          service.submitRequest('R1', 'E001', 'NYC', 'vacation', 5)
        ).rejects.toThrow('Not found');
      } finally {
        await closeServer(server);
      }
    });
  });

  // --- Line 246: 500+ with retry exhaustion ---

  describe('makeRequest — 500 with all retries exhausted', () => {
    test('should reject with HCM error after exhausting retries', async () => {
      let attempts = 0;
      const { server, port } = await createMockServer((req, res) => {
        attempts++;
        res.writeHead(503);
        res.end('Service Unavailable');
      });

      try {
        const service = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 2);
        await expect(
          service.submitRequest('R2', 'E001', 'NYC', 'vacation', 5)
        ).rejects.toThrow('HCM error');
        expect(attempts).toBe(2); // initial + 1 retry
      } finally {
        await closeServer(server);
      }
    });
  });

  // --- Lines 253-254: connection error with retry ---

  describe('makeRequest — connection error with retry exhaustion', () => {
    test('should reject after retries on connection refused', async () => {
      // Port 19999 should be unused — connection will be refused
      const service = new HCMSyncService(db, balanceService, 'http://localhost:19999', 2000, 2);
      await expect(
        service.submitRequest('R3', 'E001', 'NYC', 'vacation', 5)
      ).rejects.toThrow(); // ECONNREFUSED after retries
    });
  });

  // --- Lines 263-270: timeout with retry ---

  describe('makeRequest — timeout with retry exhaustion', () => {
    test('should reject with timeout after retries', async () => {
      const { server, port } = await createMockServer((_req, _res) => {
        // Never respond — causes timeout
      });

      try {
        // Very short timeout, 2 attempts
        const service = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 100, 2);
        await expect(
          service.submitRequest('R4', 'E001', 'NYC', 'vacation', 5)
        ).rejects.toThrow('timeout');
      } finally {
        await closeServer(server);
      }
    }, 15000);
  });

  // --- Line 280: URL parse error ---

  describe('makeRequest — invalid URL', () => {
    test('should reject on unparseable URL', async () => {
      const service = new HCMSyncService(db, balanceService, 'not-a-valid-url', 1000, 1);
      await expect(
        service.submitRequest('R5', 'E001', 'NYC', 'vacation', 5)
      ).rejects.toThrow();
    });
  });

  // --- Lines 116-117: batchSync location processing error ---

  describe('batchSync — location processing error', () => {
    test('should report failed locations when batchUpdateBalances throws', async () => {
      // Serve valid batch data from mock HCM
      const { server, port } = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            balances: [
              { employeeId: 'E001', locationId: 'NYC', balanceType: 'vacation', balance: 10, hcmVersion: 1 },
              { employeeId: 'E002', locationId: 'LA', balanceType: 'vacation', balance: 5, hcmVersion: 1 },
            ],
          })
        );
      });

      try {
        // Spy on balanceService.batchUpdateBalances to throw for one location
        const origBatch = balanceService.batchUpdateBalances.bind(balanceService);
        let callCount = 0;
        jest.spyOn(balanceService, 'batchUpdateBalances').mockImplementation(async (updates) => {
          callCount++;
          if (callCount === 1) {
            throw new Error('Simulated DB failure');
          }
          return origBatch(updates);
        });

        const service = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
        const result = await service.batchSync();

        expect(result.failedLocations.length).toBeGreaterThan(0);
        expect(result.success).toBe(false);
      } finally {
        await closeServer(server);
        jest.restoreAllMocks();
      }
    });
  });

  // --- Non-standard status code (e.g. 400) ---

  describe('makeRequest — 4xx non-404 response', () => {
    test('should reject with HTTP status code error', async () => {
      const { server, port } = await createMockServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          res.writeHead(400);
          res.end('Bad Request');
        });
      });

      try {
        const service = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
        await expect(
          service.submitRequest('R6', 'E001', 'NYC', 'vacation', 5)
        ).rejects.toThrow('HTTP 400');
      } finally {
        await closeServer(server);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// BalanceService — cache-with-DB integration (cache miss → DB → set cache)
// ---------------------------------------------------------------------------

describe('BalanceService — cache miss paths', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  test('getBalance cache miss with existing row sets cache', async () => {
    seedBalance(db, { employeeId: 'E_CACHE', locationId: 'NYC', currentBalance: 15 });
    const mockCache = {
      get: jest.fn().mockResolvedValue(null), // cache miss
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      delPattern: jest.fn().mockResolvedValue(undefined),
      healthCheck: jest.fn().mockResolvedValue(true),
      connect: jest.fn(),
      disconnect: jest.fn(),
    } as any;

    const service = new BalanceService(db, mockCache);
    const balance = await service.getBalance('E_CACHE', 'NYC', 'vacation');
    expect(balance.currentBalance).toBe(15);
    expect(mockCache.get).toHaveBeenCalledTimes(1);
    expect(mockCache.set).toHaveBeenCalledTimes(1);
  });

  test('getBalance cache miss with no existing row creates balance and sets cache', async () => {
    const mockCache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      delPattern: jest.fn().mockResolvedValue(undefined),
      healthCheck: jest.fn().mockResolvedValue(true),
      connect: jest.fn(),
      disconnect: jest.fn(),
    } as any;

    const service = new BalanceService(db, mockCache);
    const balance = await service.getBalance('NEW_EMP', 'NYC', 'vacation');
    expect(balance.currentBalance).toBe(0);
    expect(mockCache.set).toHaveBeenCalledTimes(1);
  });

  test('getAllBalancesForEmployee cache miss fetches from DB and sets cache', async () => {
    seedBalance(db, { employeeId: 'E_ALL', locationId: 'NYC', currentBalance: 10 });
    seedBalance(db, { employeeId: 'E_ALL', locationId: 'LA', balanceType: 'sick', currentBalance: 5 });
    const mockCache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      delPattern: jest.fn().mockResolvedValue(undefined),
      healthCheck: jest.fn().mockResolvedValue(true),
      connect: jest.fn(),
      disconnect: jest.fn(),
    } as any;

    const service = new BalanceService(db, mockCache);
    const balances = await service.getAllBalancesForEmployee('E_ALL');
    expect(balances).toHaveLength(2);
    expect(mockCache.set).toHaveBeenCalledTimes(1);
  });

  test('deductBalance invalidates cache after success', async () => {
    seedBalance(db, { employeeId: 'E_DED', locationId: 'NYC', currentBalance: 20 });
    const mockCache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      delPattern: jest.fn().mockResolvedValue(undefined),
      healthCheck: jest.fn().mockResolvedValue(true),
      connect: jest.fn(),
      disconnect: jest.fn(),
    } as any;

    const service = new BalanceService(db, mockCache);
    await service.deductBalance('E_DED', 'NYC', 'vacation', 5, 1);
    // del called for balance key + employee list key
    expect(mockCache.del).toHaveBeenCalledTimes(2);
  });

  test('batchUpdateBalances invalidates cache per update', async () => {
    const mockCache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      delPattern: jest.fn().mockResolvedValue(undefined),
      healthCheck: jest.fn().mockResolvedValue(true),
      connect: jest.fn(),
      disconnect: jest.fn(),
    } as any;

    const service = new BalanceService(db, mockCache);
    await service.batchUpdateBalances([
      { employeeId: 'E_B1', locationId: 'NYC', balanceType: 'vacation', balance: 10, version: 1 },
      { employeeId: 'E_B2', locationId: 'LA', balanceType: 'sick', balance: 5, version: 1 },
    ]);
    // 2 updates × 2 del calls each = 4
    expect(mockCache.del).toHaveBeenCalledTimes(4);
  });
});
