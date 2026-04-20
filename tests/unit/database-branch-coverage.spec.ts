/**
 * Additional branch coverage tests for database, migrator, and remaining service branches.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import DatabaseConnection from '../../src/database/database';
import { Migrator, Migration } from '../../src/database/migrator';
import { BalanceService } from '../../src/services/balance.service';
import { RequestService } from '../../src/services/request.service';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// DatabaseConnection branch coverage
// ---------------------------------------------------------------------------

describe('DatabaseConnection — branch coverage', () => {
  test('constructor uses DB_PATH env var when no argument given', () => {
    const original = process.env.DB_PATH;
    process.env.DB_PATH = '/tmp/env-test.db';
    const conn = new DatabaseConnection();
    expect((conn as any).dbPath).toBe('/tmp/env-test.db');
    if (original !== undefined) {
      process.env.DB_PATH = original;
    } else {
      delete process.env.DB_PATH;
    }
  });

  test('constructor falls back to default path when no arg and no env var', () => {
    const original = process.env.DB_PATH;
    delete process.env.DB_PATH;
    const conn = new DatabaseConnection();
    expect((conn as any).dbPath).toBe('./data/timeoff.db');
    if (original !== undefined) {
      process.env.DB_PATH = original;
    }
  });

  test('initialize creates directory if it does not exist', async () => {
    const tmpDir = path.join('/tmp', `wizda-test-${Date.now()}`);
    const dbPath = path.join(tmpDir, 'test.db');
    const conn = new DatabaseConnection(dbPath);
    try {
      await conn.initialize();
      expect(fs.existsSync(tmpDir)).toBe(true);
      expect(conn.isInitialized()).toBe(true);
    } finally {
      await conn.close();
      fs.unlinkSync(dbPath);
      // Clean up WAL/SHM if present
      try { fs.unlinkSync(dbPath + '-wal'); } catch {}
      try { fs.unlinkSync(dbPath + '-shm'); } catch {}
      fs.rmdirSync(tmpDir);
    }
  });

  test('initialize skips directory creation for :memory:', async () => {
    const conn = new DatabaseConnection(':memory:');
    await conn.initialize();
    expect(conn.isInitialized()).toBe(true);
    await conn.close();
  });

  test('getDatabase throws when not initialized', () => {
    const conn = new DatabaseConnection(':memory:');
    expect(() => conn.getDatabase()).toThrow('Database not initialized');
  });

  test('isInitialized returns false before initialize', () => {
    const conn = new DatabaseConnection(':memory:');
    expect(conn.isInitialized()).toBe(false);
  });

  test('close is a no-op when not initialized', async () => {
    const conn = new DatabaseConnection(':memory:');
    await conn.close(); // should not throw
  });

  test('reset for in-memory database truncates tables', async () => {
    const conn = new DatabaseConnection(':memory:');
    await conn.initialize();
    const db = conn.getDatabase();

    // Insert data
    db.prepare("INSERT INTO locations (id, name) VALUES ('X', 'Test')").run();
    expect((db.prepare('SELECT count(*) as c FROM locations').get() as any).c).toBe(1);

    await conn.reset();
    const db2 = conn.getDatabase();
    expect((db2.prepare('SELECT count(*) as c FROM locations').get() as any).c).toBe(0);

    await conn.close();
  });

  test('reset throws when not initialized', async () => {
    const conn = new DatabaseConnection(':memory:');
    await expect(conn.reset()).rejects.toThrow('Database not initialized');
  });

  test('reset for in-memory database rethrows on internal error', async () => {
    const conn = new DatabaseConnection(':memory:');
    await conn.initialize();
    const db = conn.getDatabase();

    // Close the underlying DB so the pragma call inside reset() fails
    db.close();
    // Patch isInitialized check — db reference still exists but is closed
    await expect(conn.reset()).rejects.toThrow();
  });

  test('reset for file-based database deletes and reinitializes', async () => {
    const tmpDir = path.join('/tmp', `wizda-test-${Date.now()}`);
    const dbPath = path.join(tmpDir, 'test.db');
    const conn = new DatabaseConnection(dbPath);

    await conn.initialize();
    const db = conn.getDatabase();
    db.prepare("INSERT INTO locations (id, name) VALUES ('Y', 'Loc')").run();

    await conn.reset();
    const db2 = conn.getDatabase();
    // After reset, tables exist but data is gone
    expect((db2.prepare('SELECT count(*) as c FROM locations').get() as any).c).toBe(0);

    await conn.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  });

  test('initialize with existing directory does not fail', async () => {
    const tmpDir = path.join('/tmp', `wizda-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const dbPath = path.join(tmpDir, 'test.db');
    const conn = new DatabaseConnection(dbPath);
    await conn.initialize();
    expect(conn.isInitialized()).toBe(true);
    await conn.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  });

  test('initialize catches and rethrows errors', async () => {
    // Try to initialize with an invalid path that will fail
    const conn = new DatabaseConnection('/nonexistent/deeply/nested/impossible/path/db.sqlite');
    await expect(conn.initialize()).rejects.toThrow();
  });

  test('second initialize after successful one works (up to date branch)', async () => {
    const conn = new DatabaseConnection(':memory:');
    await conn.initialize();
    // Close and reinit — migrations already applied, hits "up to date" branch
    await conn.close();
    // Can't reinit same instance after close for in-memory, but we can create a new
    // file-based one to test the "up to date" branch
    const tmpDir = path.join('/tmp', `wizda-test-${Date.now()}`);
    const dbPath = path.join(tmpDir, 'test.db');
    const conn2 = new DatabaseConnection(dbPath);
    await conn2.initialize(); // First run — applies migrations
    await conn2.close();

    const conn3 = new DatabaseConnection(dbPath);
    await conn3.initialize(); // Second run — "up to date"
    expect(conn3.isInitialized()).toBe(true);
    await conn3.close();

    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  });
});

// ---------------------------------------------------------------------------
// Migrator branch coverage
// ---------------------------------------------------------------------------

describe('Migrator — branch coverage', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  test('skips already-applied migrations', () => {
    const migration: Migration = {
      name: 'test_migration',
      up: (d) => d.exec('CREATE TABLE test_table (id TEXT)'),
      down: (d) => d.exec('DROP TABLE test_table'),
    };

    const migrator = new Migrator(db);

    // First run — applies
    const result1 = migrator.run([migration]);
    expect(result1.applied).toContain('test_migration');
    expect(result1.skipped).toHaveLength(0);

    // Second run — skips
    const result2 = migrator.run([migration]);
    expect(result2.skipped).toContain('test_migration');
    expect(result2.applied).toHaveLength(0);
  });

  test('throws and stops on failed migration', () => {
    const badMigration: Migration = {
      name: 'bad_migration',
      up: () => { throw new Error('Intentional failure'); },
      down: () => {},
    };

    const migrator = new Migrator(db);
    expect(() => migrator.run([badMigration])).toThrow('Intentional failure');
  });

  test('applies multiple migrations in order', () => {
    const m1: Migration = {
      name: 'm1',
      up: (d) => d.exec('CREATE TABLE t1 (id TEXT)'),
      down: (d) => d.exec('DROP TABLE t1'),
    };
    const m2: Migration = {
      name: 'm2',
      up: (d) => d.exec('CREATE TABLE t2 (id TEXT)'),
      down: (d) => d.exec('DROP TABLE t2'),
    };

    const migrator = new Migrator(db);
    const result = migrator.run([m1, m2]);
    expect(result.applied).toEqual(['m1', 'm2']);
  });
});

// ---------------------------------------------------------------------------
// BalanceService — remaining branch coverage
// ---------------------------------------------------------------------------

describe('BalanceService — remaining branch coverage', () => {
  let db: Database.Database;

  function createDb(): Database.Database {
    const d = new Database(':memory:');
    d.exec(`
      CREATE TABLE balances (
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
      CREATE TABLE audit_logs (
        id TEXT PRIMARY KEY,
        entity_type TEXT,
        entity_id TEXT,
        event_type TEXT,
        actor TEXT,
        details TEXT,
        created_at TEXT
      );
      CREATE TABLE requests (
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
      CREATE TABLE managers (
        id TEXT PRIMARY KEY,
        manager_id TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        location_id TEXT NOT NULL,
        UNIQUE(manager_id, employee_id, location_id)
      );
    `);
    return d;
  }

  function seedBalance(d: Database.Database, opts: { employeeId: string; locationId: string; balanceType?: string; currentBalance: number; version?: number }) {
    const now = new Date().toISOString();
    d.prepare(
      'INSERT INTO balances (id, employee_id, location_id, balance_type, current_balance, hcm_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(uuidv4(), opts.employeeId, opts.locationId, opts.balanceType || 'vacation', opts.currentBalance, opts.version || 1, now, now);
  }

  beforeEach(() => {
    db = createDb();
  });

  afterEach(() => {
    db.close();
  });

  test('deductBalance with negative amount (refund) succeeds even if it would exceed original', async () => {
    seedBalance(db, { employeeId: 'E100', locationId: 'NYC', currentBalance: 5 });
    const service = new BalanceService(db);
    // Deduct -3 (refund 3 days) — newBalance = 5 - (-3) = 8
    const result = await service.deductBalance('E100', 'NYC', 'vacation', -3, 1);
    expect(result.currentBalance).toBe(8);
  });

  test('getBalance creates new balance when none exists', async () => {
    const service = new BalanceService(db);
    const balance = await service.getBalance('NEWBIE', 'NYC', 'vacation');
    expect(balance.currentBalance).toBe(0);
    expect(balance.employeeId).toBe('NEWBIE');
  });

  test('getBalance with HCM fetch returns null branch (no cache, row exists)', async () => {
    seedBalance(db, { employeeId: 'E200', locationId: 'NYC', currentBalance: 15 });
    const service = new BalanceService(db);
    const b = await service.getBalance('E200', 'NYC', 'vacation');
    expect(b.currentBalance).toBe(15);
    expect(b.lastSyncedAt).toBeUndefined();
  });

  test('getAllBalancesForEmployee returns empty array for unknown employee', async () => {
    const service = new BalanceService(db);
    const result = await service.getAllBalancesForEmployee('NOBODY');
    expect(result).toEqual([]);
  });

  test('batchUpdateBalances inserts new balances (no existing)', async () => {
    const service = new BalanceService(db);
    const result = await service.batchUpdateBalances([
      { employeeId: 'E300', locationId: 'NYC', balanceType: 'vacation', balance: 20, version: 1 },
      { employeeId: 'E300', locationId: 'LA', balanceType: 'sick', balance: 10, version: 1 },
    ]);
    expect(result.updatedCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(result.success).toBe(true);
  });

  test('batchUpdateBalances updates existing balances', async () => {
    seedBalance(db, { employeeId: 'E301', locationId: 'NYC', currentBalance: 10 });
    const service = new BalanceService(db);
    const result = await service.batchUpdateBalances([
      { employeeId: 'E301', locationId: 'NYC', balanceType: 'vacation', balance: 25, version: 2 },
    ]);
    expect(result.updatedCount).toBe(1);
    const b = await service.getBalance('E301', 'NYC', 'vacation');
    expect(b.currentBalance).toBe(25);
  });

  test('detectDivergence with increase type', async () => {
    const service = new BalanceService(db);
    const result = await service.detectDivergence(10, 15, 5);
    expect(result.detected).toBe(true);
    expect(result.type).toBe('increase');
    expect(result.isValid).toBe(true);
  });

  test('detectDivergence with decrease that makes request invalid', async () => {
    const service = new BalanceService(db);
    const result = await service.detectDivergence(10, 3, 5);
    expect(result.detected).toBe(true);
    expect(result.type).toBe('decrease');
    expect(result.isValid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RequestService — remaining branch coverage
// ---------------------------------------------------------------------------

describe('RequestService — remaining branch coverage', () => {
  let db: Database.Database;

  function createDb(): Database.Database {
    const d = new Database(':memory:');
    d.exec(`
      CREATE TABLE balances (
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
      CREATE TABLE audit_logs (
        id TEXT PRIMARY KEY,
        entity_type TEXT,
        entity_id TEXT,
        event_type TEXT,
        actor TEXT,
        details TEXT,
        created_at TEXT
      );
      CREATE TABLE requests (
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
      CREATE TABLE managers (
        id TEXT PRIMARY KEY,
        manager_id TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        location_id TEXT NOT NULL,
        UNIQUE(manager_id, employee_id, location_id)
      );
    `);
    return d;
  }

  function seedBalance(d: Database.Database, opts: { employeeId: string; locationId: string; currentBalance: number }) {
    const now = new Date().toISOString();
    d.prepare(
      'INSERT INTO balances (id, employee_id, location_id, balance_type, current_balance, hcm_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(uuidv4(), opts.employeeId, opts.locationId, 'vacation', opts.currentBalance, 1, now, now);
  }

  beforeEach(() => {
    db = createDb();
  });

  afterEach(() => {
    db.close();
  });

  test('approveRequest with wrong location throws Unauthorized', async () => {
    seedBalance(db, { employeeId: 'E400', locationId: 'NYC', currentBalance: 20 });
    const balanceService = new BalanceService(db);
    const requestService = new RequestService(db, balanceService);

    const req = await requestService.submitRequest({
      employeeId: 'E400', locationId: 'NYC', balanceType: 'vacation', daysRequested: 2
    });

    await expect(
      requestService.approveRequest(req.id, 'M001', 'LA')
    ).rejects.toThrow('Unauthorized');
  });

  test('markHCMApproved sets approved status', async () => {
    seedBalance(db, { employeeId: 'E401', locationId: 'NYC', currentBalance: 20 });
    const balanceService = new BalanceService(db);
    const requestService = new RequestService(db, balanceService);

    const req = await requestService.submitRequest({
      employeeId: 'E401', locationId: 'NYC', balanceType: 'vacation', daysRequested: 2
    });
    // Move to processing first
    await requestService.approveRequest(req.id, 'M001', 'NYC');

    const approved = await requestService.markHCMApproved(req.id);
    expect(approved.status).toBe('approved');
    expect(approved.hcmApprovedAt).toBeInstanceOf(Date);
  });

  test('markHCMRejected sets rejected status with default reason', async () => {
    seedBalance(db, { employeeId: 'E402', locationId: 'NYC', currentBalance: 20 });
    const balanceService = new BalanceService(db);
    const requestService = new RequestService(db, balanceService);

    const req = await requestService.submitRequest({
      employeeId: 'E402', locationId: 'NYC', balanceType: 'vacation', daysRequested: 2
    });
    await requestService.approveRequest(req.id, 'M001', 'NYC');

    const rejected = await requestService.markHCMRejected(req.id);
    expect(rejected.status).toBe('rejected');
    expect(rejected.managerReason).toBe('Rejected by HCM');
  });

  test('markHCMRejected with custom reason', async () => {
    seedBalance(db, { employeeId: 'E403', locationId: 'NYC', currentBalance: 20 });
    const balanceService = new BalanceService(db);
    const requestService = new RequestService(db, balanceService);

    const req = await requestService.submitRequest({
      employeeId: 'E403', locationId: 'NYC', balanceType: 'vacation', daysRequested: 2
    });
    await requestService.approveRequest(req.id, 'M001', 'NYC');

    const rejected = await requestService.markHCMRejected(req.id, 'Policy violation');
    expect(rejected.managerReason).toBe('Policy violation');
  });

  test('recordHCMSubmission sets submission fields', async () => {
    seedBalance(db, { employeeId: 'E404', locationId: 'NYC', currentBalance: 20 });
    const balanceService = new BalanceService(db);
    const requestService = new RequestService(db, balanceService);

    const req = await requestService.submitRequest({
      employeeId: 'E404', locationId: 'NYC', balanceType: 'vacation', daysRequested: 2
    });
    await requestService.approveRequest(req.id, 'M001', 'NYC');

    const recorded = await requestService.recordHCMSubmission(req.id, 'SUB-123');
    expect(recorded.hcmSubmissionId).toBe('SUB-123');
    expect(recorded.submittedToHcmAt).toBeInstanceOf(Date);
  });

  test('approveRequest auto-rejects when balance decreased below threshold', async () => {
    seedBalance(db, { employeeId: 'E405', locationId: 'NYC', currentBalance: 20 });
    const balanceService = new BalanceService(db);
    const requestService = new RequestService(db, balanceService);

    const req = await requestService.submitRequest({
      employeeId: 'E405', locationId: 'NYC', balanceType: 'vacation', daysRequested: 18
    });

    // Simulate balance decrease below request amount
    db.prepare('UPDATE balances SET current_balance = 10 WHERE employee_id = ?').run('E405');

    const result = await requestService.approveRequest(req.id, 'M001', 'NYC');
    expect(result.status).toBe('rejected');
    expect(result.divergenceReason).toContain('Insufficient balance');
  });

  test('approveRequest auto-approves when balance increased', async () => {
    seedBalance(db, { employeeId: 'E406', locationId: 'NYC', currentBalance: 20 });
    const balanceService = new BalanceService(db);
    const requestService = new RequestService(db, balanceService);

    const req = await requestService.submitRequest({
      employeeId: 'E406', locationId: 'NYC', balanceType: 'vacation', daysRequested: 5
    });

    // Simulate balance increase
    db.prepare('UPDATE balances SET current_balance = 25 WHERE employee_id = ?').run('E406');

    const result = await requestService.approveRequest(req.id, 'M001', 'NYC');
    expect(result.status).toBe('processing');
    expect(result.divergenceReason).toContain('Balance changed');
  });

  test('confirmRequest with proceed transitions to processing', async () => {
    seedBalance(db, { employeeId: 'E407', locationId: 'NYC', currentBalance: 20 });
    const balanceService = new BalanceService(db);
    const requestService = new RequestService(db, balanceService);

    const req = await requestService.submitRequest({
      employeeId: 'E407', locationId: 'NYC', balanceType: 'vacation', daysRequested: 15
    });

    // Simulate decrease that still valid → pending_employee_confirmation
    db.prepare('UPDATE balances SET current_balance = 16 WHERE employee_id = ?').run('E407');
    const approved = await requestService.approveRequest(req.id, 'M001', 'NYC');
    expect(approved.status).toBe('pending_employee_confirmation');

    const confirmed = await requestService.confirmRequest(req.id, 'E407', 'proceed');
    expect(confirmed.status).toBe('processing');
  });

  test('confirmRequest with cancel rejects the request', async () => {
    seedBalance(db, { employeeId: 'E408', locationId: 'NYC', currentBalance: 20 });
    const balanceService = new BalanceService(db);
    const requestService = new RequestService(db, balanceService);

    const req = await requestService.submitRequest({
      employeeId: 'E408', locationId: 'NYC', balanceType: 'vacation', daysRequested: 15
    });

    db.prepare('UPDATE balances SET current_balance = 16 WHERE employee_id = ?').run('E408');
    await requestService.approveRequest(req.id, 'M001', 'NYC');

    const cancelled = await requestService.confirmRequest(req.id, 'E408', 'cancel');
    expect(cancelled.status).toBe('rejected');
  });
});
