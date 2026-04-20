/**
 * Unit Tests: HCMSyncService
 * Tests HCM communication: fetching, batch sync, submission, polling, health check
 * Uses a real mock HTTP server for realistic testing
 */

import * as http from 'http';
import Database from 'better-sqlite3';
import { HCMSyncService } from '../../src/services/hcm-sync.service';
import { BalanceService } from '../../src/services/balance.service';

// Lightweight mock HTTP server for unit tests
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

describe('HCMSyncService', () => {
  let db: Database.Database;
  let balanceService: BalanceService;

  beforeEach(() => {
    db = new Database(':memory:');

    // Create required tables
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

    balanceService = new BalanceService(db);
  });

  afterEach(() => {
    db.close();
  });

  // ===== fetchBalance =====

  describe('fetchBalance', () => {
    test('should fetch and return balance map from HCM', async () => {
      const { server, port } = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          balances: {
            vacation: { balance: 15 },
            sick: { balance: 10 },
            personal: { balance: 5 },
          }
        }));
      });

      try {
        const service = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
        const result = await service.fetchBalance('E001', 'NYC');

        expect(result).toEqual({
          vacation: 15,
          sick: 10,
          personal: 5,
        });
      } finally {
        await closeServer(server);
      }
    });

    test('should return null when HCM returns no balances', async () => {
      const { server, port } = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
      });

      try {
        const service = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
        const result = await service.fetchBalance('E001', 'NYC');
        expect(result).toBeNull();
      } finally {
        await closeServer(server);
      }
    });

    test('should return null on server error', async () => {
      const { server, port } = await createMockServer((req, res) => {
        res.writeHead(500);
        res.end('Internal Server Error');
      });

      try {
        const service = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
        const result = await service.fetchBalance('E001', 'NYC');
        expect(result).toBeNull();
      } finally {
        await closeServer(server);
      }
    });

    test('should return null on connection refused', async () => {
      const service = new HCMSyncService(db, balanceService, 'http://localhost:19999', 1000, 1);
      const result = await service.fetchBalance('E001', 'NYC');
      expect(result).toBeNull();
    });

    test('should default missing balance types to 0', async () => {
      const { server, port } = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          balances: {
            vacation: { balance: 10 },
            // sick and personal missing
          }
        }));
      });

      try {
        const service = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
        const result = await service.fetchBalance('E001', 'NYC');

        expect(result).toEqual({
          vacation: 10,
          sick: 0,
          personal: 0,
        });
      } finally {
        await closeServer(server);
      }
    });
  });

  // ===== batchSync =====

  describe('batchSync', () => {
    test('should sync balances from HCM grouped by location', async () => {
      const { server, port } = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          balances: [
            { employeeId: 'E001', locationId: 'NYC', balanceType: 'vacation', balance: 15, hcmVersion: 2 },
            { employeeId: 'E001', locationId: 'NYC', balanceType: 'sick', balance: 10, hcmVersion: 2 },
            { employeeId: 'E002', locationId: 'LA', balanceType: 'vacation', balance: 20, hcmVersion: 3 },
          ]
        }));
      });

      try {
        const service = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
        const result = await service.batchSync();

        expect(result.success).toBe(true);
        expect(result.updatedCount).toBe(3);
        expect(result.failedLocations).toEqual([]);

        // Verify balances were stored
        const balance = await balanceService.getBalance('E001', 'NYC', 'vacation');
        expect(balance.currentBalance).toBe(15);
      } finally {
        await closeServer(server);
      }
    });

    test('should return failure when HCM returns invalid data', async () => {
      const { server, port } = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad data' }));
      });

      try {
        const service = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
        const result = await service.batchSync();

        expect(result.success).toBe(false);
        expect(result.updatedCount).toBe(0);
      } finally {
        await closeServer(server);
      }
    });

    test('should handle connection failure', async () => {
      const service = new HCMSyncService(db, balanceService, 'http://localhost:19999', 1000, 1);
      const result = await service.batchSync();

      expect(result.success).toBe(false);
      expect(result.failedLocations).toContain('all');
    });
  });

  // ===== submitRequest =====

  describe('submitRequest', () => {
    test('should submit request and return submissionId', async () => {
      const { server, port } = await createMockServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => body += chunk);
        req.on('end', () => {
          const parsed = JSON.parse(body);
          expect(parsed.employeeId).toBe('E001');
          expect(parsed.locationId).toBe('NYC');
          expect(parsed.balanceType).toBe('vacation');
          expect(parsed.daysRequested).toBe(5);

          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            submissionId: 'SUB-123',
            status: 'received',
            createdAt: new Date().toISOString(),
          }));
        });
      });

      try {
        const service = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
        const submissionId = await service.submitRequest('REQ-1', 'E001', 'NYC', 'vacation', 5);
        expect(submissionId).toBe('SUB-123');
      } finally {
        await closeServer(server);
      }
    });

    test('should throw when HCM returns no submissionId', async () => {
      const { server, port } = await createMockServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => body += chunk);
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid' }));
        });
      });

      try {
        const service = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
        await expect(service.submitRequest('REQ-1', 'E001', 'NYC', 'vacation', 5))
          .rejects.toThrow('Invalid HCM response: missing submissionId');
      } finally {
        await closeServer(server);
      }
    });

    test('should throw on server error', async () => {
      const { server, port } = await createMockServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => body += chunk);
        req.on('end', () => {
          res.writeHead(500);
          res.end('Server Error');
        });
      });

      try {
        const service = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
        await expect(service.submitRequest('REQ-1', 'E001', 'NYC', 'vacation', 5))
          .rejects.toThrow();
      } finally {
        await closeServer(server);
      }
    });
  });

  // ===== pollStatus =====

  describe('pollStatus', () => {
    test('should return approved status', async () => {
      const { server, port } = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'approved' }));
      });

      try {
        const service = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
        const status = await service.pollStatus('SUB-123');
        expect(status).toBe('approved');
      } finally {
        await closeServer(server);
      }
    });

    test('should return rejected status', async () => {
      const { server, port } = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'rejected' }));
      });

      try {
        const service = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
        const status = await service.pollStatus('SUB-123');
        expect(status).toBe('rejected');
      } finally {
        await closeServer(server);
      }
    });

    test('should return processing when HCM has no status', async () => {
      const { server, port } = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
      });

      try {
        const service = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
        const status = await service.pollStatus('SUB-123');
        expect(status).toBe('processing');
      } finally {
        await closeServer(server);
      }
    });

    test('should return processing on error (safe default)', async () => {
      const service = new HCMSyncService(db, balanceService, 'http://localhost:19999', 1000, 1);
      const status = await service.pollStatus('SUB-123');
      expect(status).toBe('processing');
    });
  });

  // ===== healthCheck =====

  describe('healthCheck', () => {
    test('should return true when HCM is healthy', async () => {
      const { server, port } = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      });

      try {
        const service = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 1);
        const healthy = await service.healthCheck();
        expect(healthy).toBe(true);
      } finally {
        await closeServer(server);
      }
    });

    test('should return false when HCM is down', async () => {
      const service = new HCMSyncService(db, balanceService, 'http://localhost:19999', 1000, 1);
      const healthy = await service.healthCheck();
      expect(healthy).toBe(false);
    });
  });

  // ===== retry logic =====

  describe('retry logic', () => {
    test('should retry on 500 errors and succeed on retry', async () => {
      let attempt = 0;
      const { server, port } = await createMockServer((req, res) => {
        attempt++;
        if (attempt < 2) {
          res.writeHead(500);
          res.end('Server Error');
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        }
      });

      try {
        const service = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 3);
        const healthy = await service.healthCheck();
        expect(healthy).toBe(true);
        expect(attempt).toBe(2);
      } finally {
        await closeServer(server);
      }
    });

    test('should fail after exhausting retries', async () => {
      const { server, port } = await createMockServer((req, res) => {
        res.writeHead(500);
        res.end('Server Error');
      });

      try {
        const service = new HCMSyncService(db, balanceService, `http://localhost:${port}`, 5000, 2);
        const healthy = await service.healthCheck();
        expect(healthy).toBe(false);
      } finally {
        await closeServer(server);
      }
    });
  });
});
