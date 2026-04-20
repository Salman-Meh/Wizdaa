/**
 * RequestService Unit Tests
 * Tests request lifecycle: submission, approval, divergence handling, HCM processing
 */

import { RequestService } from './request.service';
import { BalanceService } from './balance.service';
import { setupTestEnvironment, teardownTestEnvironment, getTestDatabase, resetTestState } from '../../tests/setup';
import { v4 as uuidv4 } from 'uuid';

describe('RequestService', () => {
  let requestService: RequestService;
  let balanceService: BalanceService;
  let db: any;

  beforeAll(async () => {
    await setupTestEnvironment();
    db = getTestDatabase();
    balanceService = new BalanceService(db);
    requestService = new RequestService(db, balanceService);
  });

  afterAll(async () => {
    await teardownTestEnvironment();
  });

  afterEach(async () => {
    await resetTestState();
  });

  describe('submitRequest', () => {
    test('should create request with pending_manager_approval status', async () => {
      // Setup: Create balance for employee with sufficient balance
      const balId = require('uuid').v4();
      db.prepare(
        `INSERT INTO balances (id, employee_id, location_id, balance_type, current_balance, hcm_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(balId, 'E001', 'NYC', 'vacation', 10, 1, new Date().toISOString(), new Date().toISOString());

      const request = await requestService.submitRequest({
        employeeId: 'E001',
        locationId: 'NYC',
        balanceType: 'vacation',
        daysRequested: 5
      });

      expect(request).toBeDefined();
      expect(request.status).toBe('pending_manager_approval');
      expect(request.requestedBalanceAtSubmission).toBe(10);
      expect(request.employeeId).toBe('E001');
      expect(request.locationId).toBe('NYC');
    });

    test('should reject if insufficient balance', async () => {
      // Setup: Create balance with insufficient amount
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

      expect(
        requestService.submitRequest({
          employeeId: 'E001',
          locationId: 'NYC',
          balanceType: 'vacation',
          daysRequested: 5
        })
      ).rejects.toThrow('Insufficient balance');
    });

    test('should store requested balance at submission time for divergence detection', async () => {
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

      const request = await requestService.submitRequest({
        employeeId: 'E001',
        locationId: 'NYC',
        balanceType: 'vacation',
        daysRequested: 5
      });

      expect(request.requestedBalanceAtSubmission).toBe(20);
    });

    test('should create audit log for submission', async () => {
      const balId = require('uuid').v4();
      db.prepare(
        `INSERT INTO balances (id, employee_id, location_id, balance_type, current_balance, hcm_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(balId, 'E001', 'NYC', 'vacation', 10, 1, new Date().toISOString(), new Date().toISOString());

      const request = await requestService.submitRequest({
        employeeId: 'E001',
        locationId: 'NYC',
        balanceType: 'vacation',
        daysRequested: 5
      });

      // Verify audit log was created
      const auditStmt = db.prepare(
        `SELECT * FROM audit_logs WHERE entity_id = ? AND event_type = 'request_submitted'`
      );
      const auditLog = auditStmt.get(request.id);

      expect(auditLog).toBeDefined();
    });
  });

  describe('approveRequest', () => {
    test('should transition from pending_manager_approval to processing', async () => {
      // Setup: Create balance with sufficient amount and request
      const balId = require('uuid').v4();
      db.prepare(
        `INSERT INTO balances (id, employee_id, location_id, balance_type, current_balance, hcm_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(balId, 'E001', 'NYC', 'vacation', 10, 1, new Date().toISOString(), new Date().toISOString());

      const request = await requestService.submitRequest({
        employeeId: 'E001',
        locationId: 'NYC',
        balanceType: 'vacation',
        daysRequested: 5
      });

      // Approve
      const approved = await requestService.approveRequest(request.id, 'M001', 'NYC');

      expect(approved.status).toBe('processing');
      expect(approved.managerId).toBe('M001');
      expect(approved.managerLocationId).toBe('NYC');
    });

    test('should reject approval from manager at different location', async () => {
      // Setup: Create balance and request at NYC
      const balId = require('uuid').v4();
      db.prepare(
        `INSERT INTO balances (id, employee_id, location_id, balance_type, current_balance, hcm_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(balId, 'E001', 'NYC', 'vacation', 10, 1, new Date().toISOString(), new Date().toISOString());

      const request = await requestService.submitRequest({
        employeeId: 'E001',
        locationId: 'NYC',
        balanceType: 'vacation',
        daysRequested: 5
      });

      // Try to approve with manager from LA
      expect(
        requestService.approveRequest(request.id, 'M001', 'LA') // Wrong location
      ).rejects.toThrow('Unauthorized');
    });

    test('should detect divergence if balance changed since submission', async () => {
      // Setup: Create balance and request
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

      const request = await requestService.submitRequest({
        employeeId: 'E001',
        locationId: 'NYC',
        balanceType: 'vacation',
        daysRequested: 5
      });

      // Simulate HCM update: balance decreased from 20 to 10 (still valid for 5 days)
      await balanceService.deductBalance('E001', 'NYC', 'vacation', 10, 1); // Now 10

      // Approve - should pause for employee confirmation (valid decrease)
      const approved = await requestService.approveRequest(request.id, 'M001', 'NYC');

      expect(approved.status).toBe('pending_employee_confirmation');
      expect(approved.divergenceReason).toBeDefined();
    });

    test('should auto-reject if balance decrease makes request invalid', async () => {
      // Setup: Balance 20, request 5
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

      const request = await requestService.submitRequest({
        employeeId: 'E001',
        locationId: 'NYC',
        balanceType: 'vacation',
        daysRequested: 5
      });

      // Simulate balance decrease to 3 (policy change)
      await balanceService.deductBalance('E001', 'NYC', 'vacation', 17, 1); // Now 3

      // Approve - should auto-reject since 3 < 5
      const result = await requestService.approveRequest(request.id, 'M001', 'NYC');

      expect(result.status).toBe('rejected');
    });
  });

  describe('confirmRequest', () => {
    test('should accept proceed action and submit to HCM', async () => {
      // Setup: Create balance and request in pending_employee_confirmation
      const balId = require('uuid').v4();
      db.prepare(
        `INSERT INTO balances (id, employee_id, location_id, balance_type, current_balance, hcm_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(balId, 'E001', 'NYC', 'vacation', 10, 1, new Date().toISOString(), new Date().toISOString());

      const request = await requestService.submitRequest({
        employeeId: 'E001',
        locationId: 'NYC',
        balanceType: 'vacation',
        daysRequested: 5
      });

      // Manually set to pending_employee_confirmation for this test
      db.prepare(
        `UPDATE requests SET status = 'pending_employee_confirmation', divergence_reason = 'test' WHERE id = ?`
      ).run(request.id);

      // Confirm
      const confirmed = await requestService.confirmRequest(request.id, 'E001', 'proceed');

      expect(confirmed.status).toBe('processing');
    });

    test('should accept cancel action and reject request', async () => {
      // Setup: Create balance and request
      const balId = require('uuid').v4();
      db.prepare(
        `INSERT INTO balances (id, employee_id, location_id, balance_type, current_balance, hcm_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(balId, 'E001', 'NYC', 'vacation', 10, 1, new Date().toISOString(), new Date().toISOString());

      const request = await requestService.submitRequest({
        employeeId: 'E001',
        locationId: 'NYC',
        balanceType: 'vacation',
        daysRequested: 5
      });

      // Manually set to pending_employee_confirmation
      db.prepare(
        `UPDATE requests SET status = 'pending_employee_confirmation', divergence_reason = 'test' WHERE id = ?`
      ).run(request.id);

      // Cancel
      const cancelled = await requestService.confirmRequest(request.id, 'E001', 'cancel');

      expect(cancelled.status).toBe('rejected');
    });
  });

  describe('getRequestStatus', () => {
    test('should return request with all details', async () => {
      // Setup: Create balance and request
      const balId = require('uuid').v4();
      db.prepare(
        `INSERT INTO balances (id, employee_id, location_id, balance_type, current_balance, hcm_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(balId, 'E001', 'NYC', 'vacation', 10, 1, new Date().toISOString(), new Date().toISOString());

      const request = await requestService.submitRequest({
        employeeId: 'E001',
        locationId: 'NYC',
        balanceType: 'vacation',
        daysRequested: 5
      });

      // Get status
      const status = await requestService.getRequestStatus(request.id);

      expect(status).toBeDefined();
      expect(status.employeeId).toBe('E001');
      expect(status.status).toBe('pending_manager_approval');
      expect(status.daysRequested).toBe(5);
    });
  });

  describe('multi-location independence', () => {
    test('should handle concurrent requests from different locations independently', async () => {
      // Setup: Multi-location employee with sufficient balances
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO balances (id, employee_id, location_id, balance_type, current_balance, hcm_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(require('uuid').v4(), 'E001', 'NYC', 'vacation', 10, 1, now, now);
      db.prepare(
        `INSERT INTO balances (id, employee_id, location_id, balance_type, current_balance, hcm_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(require('uuid').v4(), 'E001', 'LA', 'vacation', 10, 1, now, now);

      // Submit from NYC
      const nycRequest = await requestService.submitRequest({
        employeeId: 'E001',
        locationId: 'NYC',
        balanceType: 'vacation',
        daysRequested: 5
      });

      // Submit from LA
      const laRequest = await requestService.submitRequest({
        employeeId: 'E001',
        locationId: 'LA',
        balanceType: 'vacation',
        daysRequested: 3
      });

      expect(nycRequest.locationId).toBe('NYC');
      expect(laRequest.locationId).toBe('LA');

      // Approve NYC request
      const nycApproved = await requestService.approveRequest(nycRequest.id, 'M_NYC', 'NYC');
      expect(nycApproved.status).toBe('processing');

      // Approve LA request
      const laApproved = await requestService.approveRequest(laRequest.id, 'M_LA', 'LA');
      expect(laApproved.status).toBe('processing');
    });
  });
});
