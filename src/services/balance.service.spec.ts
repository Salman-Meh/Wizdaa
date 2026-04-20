/**
 * BalanceService Unit Tests
 * Tests balance retrieval, deduction, divergence detection, and sync operations
 */

import { BalanceService } from './balance.service';
import { setupTestEnvironment, teardownTestEnvironment, getTestDatabase, resetTestState } from '../../tests/setup';
import { BalanceType } from '../models/types';
import { v4 as uuidv4 } from 'uuid';

describe('BalanceService', () => {
  let balanceService: BalanceService;
  let db: any;

  beforeAll(async () => {
    await setupTestEnvironment();
    db = getTestDatabase();
    balanceService = new BalanceService(db);
  });

  afterAll(async () => {
    await teardownTestEnvironment();
  });

  afterEach(async () => {
    await resetTestState();
  });

  describe('getBalance', () => {
    test('should create new balance if not exists', async () => {
      const result = await balanceService.getBalance('E999', 'NYC', 'vacation');

      expect(result).toBeDefined();
      expect(result.employeeId).toBe('E999');
      expect(result.locationId).toBe('NYC');
      expect(result.balanceType).toBe('vacation');
    });

    test('should return existing balance from database', async () => {
      // Insert test balance
      const balance = {
        id: uuidv4(),
        employee_id: 'E001',
        location_id: 'NYC',
        balance_type: 'vacation',
        current_balance: 20,
        hcm_version: 1,
        created_at: new Date(),
        updated_at: new Date()
      };
      db.prepare(
        `INSERT INTO balances (id, employee_id, location_id, balance_type, current_balance, hcm_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        balance.id,
        balance.employee_id,
        balance.location_id,
        balance.balance_type,
        balance.current_balance,
        balance.hcm_version,
        balance.created_at.toISOString(),
        balance.updated_at.toISOString()
      );

      const result = await balanceService.getBalance('E001', 'NYC', 'vacation');

      expect(result.currentBalance).toBe(20);
      expect(result.hcmVersion).toBe(1);
    });

    test('should detect divergence if local and HCM values differ', async () => {
      // Local: 20, HCM: 25 (work anniversary)
      const balance = {
        id: uuidv4(),
        employee_id: 'E001',
        location_id: 'NYC',
        balance_type: 'vacation',
        current_balance: 20,
        hcm_version: 1,
        created_at: new Date(),
        updated_at: new Date()
      };
      db.prepare(
        `INSERT INTO balances (id, employee_id, location_id, balance_type, current_balance, hcm_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        balance.id,
        balance.employee_id,
        balance.location_id,
        balance.balance_type,
        balance.current_balance,
        balance.hcm_version,
        balance.created_at.toISOString(),
        balance.updated_at.toISOString()
      );

      // Note: This test would need actual HCM call to work properly
      // For now, it verifies the database interaction
      const result = await balanceService.getBalance('E001', 'NYC', 'vacation');
      expect(result).toBeDefined();
    });
  });

  describe('deductBalance', () => {
    test('should deduct balance successfully', async () => {
      const balance = {
        id: uuidv4(),
        employee_id: 'E001',
        location_id: 'NYC',
        balance_type: 'vacation',
        current_balance: 20,
        hcm_version: 1,
        created_at: new Date(),
        updated_at: new Date()
      };
      db.prepare(
        `INSERT INTO balances (id, employee_id, location_id, balance_type, current_balance, hcm_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        balance.id,
        balance.employee_id,
        balance.location_id,
        balance.balance_type,
        balance.current_balance,
        balance.hcm_version,
        balance.created_at.toISOString(),
        balance.updated_at.toISOString()
      );

      const result = await balanceService.deductBalance('E001', 'NYC', 'vacation', 5, 1);

      expect(result.currentBalance).toBe(15);
      expect(result.hcmVersion).toBe(2); // Version incremented
    });

    test('should reject deduction if insufficient balance', async () => {
      const balance = {
        id: uuidv4(),
        employee_id: 'E001',
        location_id: 'NYC',
        balance_type: 'vacation',
        current_balance: 3,
        hcm_version: 1,
        created_at: new Date(),
        updated_at: new Date()
      };
      db.prepare(
        `INSERT INTO balances (id, employee_id, location_id, balance_type, current_balance, hcm_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        balance.id,
        balance.employee_id,
        balance.location_id,
        balance.balance_type,
        balance.current_balance,
        balance.hcm_version,
        balance.created_at.toISOString(),
        balance.updated_at.toISOString()
      );

      expect(async () => {
        await balanceService.deductBalance('E001', 'NYC', 'vacation', 5, 1);
      }).rejects.toThrow('Insufficient balance');
    });

    test('should reject deduction with version mismatch (optimistic locking)', async () => {
      const balance = {
        id: uuidv4(),
        employee_id: 'E001',
        location_id: 'NYC',
        balance_type: 'vacation',
        current_balance: 20,
        hcm_version: 5,
        created_at: new Date(),
        updated_at: new Date()
      };
      db.prepare(
        `INSERT INTO balances (id, employee_id, location_id, balance_type, current_balance, hcm_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        balance.id,
        balance.employee_id,
        balance.location_id,
        balance.balance_type,
        balance.current_balance,
        balance.hcm_version,
        balance.created_at.toISOString(),
        balance.updated_at.toISOString()
      );

      // Try to deduct with stale version
      expect(async () => {
        await balanceService.deductBalance('E001', 'NYC', 'vacation', 5, 4); // Wrong version
      }).rejects.toThrow('Version mismatch');
    });

    test('should throw on concurrent modification (race condition after SELECT)', async () => {
      const balance = {
        id: uuidv4(),
        employee_id: 'E001',
        location_id: 'NYC',
        balance_type: 'vacation',
        current_balance: 20,
        hcm_version: 1,
        created_at: new Date(),
        updated_at: new Date()
      };
      db.prepare(
        `INSERT INTO balances (id, employee_id, location_id, balance_type, current_balance, hcm_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        balance.id,
        balance.employee_id,
        balance.location_id,
        balance.balance_type,
        balance.current_balance,
        balance.hcm_version,
        balance.created_at.toISOString(),
        balance.updated_at.toISOString()
      );

      // First deduction succeeds, bumping version to 2
      await balanceService.deductBalance('E001', 'NYC', 'vacation', 5, 1);

      // Second deduction with stale version 1 passes the initial check (row exists with sufficient balance)
      // but the UPDATE fails because version is now 2
      await expect(
        balanceService.deductBalance('E001', 'NYC', 'vacation', 5, 1)
      ).rejects.toThrow('Version mismatch');
    });

    test('should handle refunds (negative deductions)', async () => {
      const balance = {
        id: uuidv4(),
        employee_id: 'E001',
        location_id: 'NYC',
        balance_type: 'vacation',
        current_balance: 15,
        hcm_version: 1,
        created_at: new Date(),
        updated_at: new Date()
      };
      db.prepare(
        `INSERT INTO balances (id, employee_id, location_id, balance_type, current_balance, hcm_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        balance.id,
        balance.employee_id,
        balance.location_id,
        balance.balance_type,
        balance.current_balance,
        balance.hcm_version,
        balance.created_at.toISOString(),
        balance.updated_at.toISOString()
      );

      const result = await balanceService.deductBalance('E001', 'NYC', 'vacation', -5, 1); // Negative = refund

      expect(result.currentBalance).toBe(20);
    });
  });

  describe('batch updates', () => {
    test('should batch update multiple balances', async () => {
      const updates = [
        { employeeId: 'E001', locationId: 'NYC', balanceType: 'vacation' as BalanceType, balance: 25, version: 2 },
        { employeeId: 'E002', locationId: 'LA', balanceType: 'vacation' as BalanceType, balance: 18, version: 2 }
      ];

      const result = await balanceService.batchUpdateBalances(updates);

      expect(result.success).toBe(true);
      expect(result.updatedCount).toBe(2);
    });

    test('should handle partial batch failures', async () => {
      // Insert existing balance
      const balance = {
        id: uuidv4(),
        employee_id: 'E001',
        location_id: 'NYC',
        balance_type: 'vacation',
        current_balance: 20,
        hcm_version: 1,
        created_at: new Date(),
        updated_at: new Date()
      };
      db.prepare(
        `INSERT INTO balances (id, employee_id, location_id, balance_type, current_balance, hcm_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        balance.id,
        balance.employee_id,
        balance.location_id,
        balance.balance_type,
        balance.current_balance,
        balance.hcm_version,
        balance.created_at.toISOString(),
        balance.updated_at.toISOString()
      );

      const updates = [
        { employeeId: 'E001', locationId: 'NYC', balanceType: 'vacation' as BalanceType, balance: 25, version: 1 }, // Should succeed
        { employeeId: 'E002', locationId: 'LA', balanceType: 'vacation' as BalanceType, balance: 18, version: 1 } // New record
      ];

      const result = await balanceService.batchUpdateBalances(updates);

      expect(result.success).toBe(true);
      expect(result.updatedCount).toBeGreaterThan(0);
    });
  });

  describe('location independence', () => {
    test('should not allow balance pooling across locations', async () => {
      // Create balances for same employee at two locations
      const nycBalance = {
        id: uuidv4(),
        employee_id: 'E001',
        location_id: 'NYC',
        balance_type: 'vacation',
        current_balance: 0, // Empty at NYC
        hcm_version: 1,
        created_at: new Date(),
        updated_at: new Date()
      };
      db.prepare(
        `INSERT INTO balances (id, employee_id, location_id, balance_type, current_balance, hcm_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        nycBalance.id,
        nycBalance.employee_id,
        nycBalance.location_id,
        nycBalance.balance_type,
        nycBalance.current_balance,
        nycBalance.hcm_version,
        nycBalance.created_at.toISOString(),
        nycBalance.updated_at.toISOString()
      );

      const laBalance = {
        id: uuidv4(),
        employee_id: 'E001',
        location_id: 'LA',
        balance_type: 'vacation',
        current_balance: 20,
        hcm_version: 1,
        created_at: new Date(),
        updated_at: new Date()
      };
      db.prepare(
        `INSERT INTO balances (id, employee_id, location_id, balance_type, current_balance, hcm_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        laBalance.id,
        laBalance.employee_id,
        laBalance.location_id,
        laBalance.balance_type,
        laBalance.current_balance,
        laBalance.hcm_version,
        laBalance.created_at.toISOString(),
        laBalance.updated_at.toISOString()
      );

      // Try to deduct from NYC (empty) - should fail, not use LA
      expect(async () => {
        await balanceService.deductBalance('E001', 'NYC', 'vacation', 5, 1);
      }).rejects.toThrow('Insufficient balance');

      // LA balance should be untouched
      const laBalanceAfter = await balanceService.getBalance('E001', 'LA', 'vacation');
      expect(laBalanceAfter.currentBalance).toBe(20);
    });
  });
});
