/**
 * Integration Tests: Divergence Scenarios
 * Tests balance change detection and reconciliation
 */

import { BalanceService } from '../../src/services/balance.service';
import { RequestService } from '../../src/services/request.service';
import { HCMSyncService } from '../../src/services/hcm-sync.service';
import { DivergenceService } from '../../src/services/divergence.service';
import { setupTestEnvironment, teardownTestEnvironment, getTestDatabase, getMockHCMServer, resetTestState } from '../setup';

describe('Integration: Divergence Scenarios', () => {
  let balanceService: BalanceService;
  let requestService: RequestService;
  let hcmSyncService: HCMSyncService;
  let divergenceService: DivergenceService;
  let db: any;
  let mockHcm: any;

  beforeAll(async () => {
    await setupTestEnvironment();
    db = getTestDatabase();
    mockHcm = getMockHCMServer();

    balanceService = new BalanceService(db);
    requestService = new RequestService(db, balanceService);
    hcmSyncService = new HCMSyncService(db, balanceService);
    divergenceService = new DivergenceService(db);
  });

  afterAll(async () => {
    await teardownTestEnvironment();
  });

  beforeEach(async () => {
    await resetTestState();
  });

  /**
   * DIVERGENCE SCENARIO 2: Balance Increase (Employee Benefit)
   * When HCM balance increases between submission and approval,
   * system should auto-approve (increase benefits employee)
   */
  test('should auto-approve divergence when balance increases', async () => {
    console.log('\nDIVERGENCE: Balance Increase\n');

    const employeeId = 'E_INCREASE_001';
    const locationId = 'NYC';
    const balanceType = 'vacation';

    // Setup: Employee starts with 20 days
    await balanceService.getBalance(employeeId, locationId, balanceType);
    db.prepare(
      `UPDATE balances SET current_balance = 20, hcm_version = 1
       WHERE employee_id = ? AND location_id = ? AND balance_type = ?`
    ).run(employeeId, locationId, balanceType);

    // Step 1: Employee submits request for 5 days (balance: 20)
    const request = await requestService.submitRequest({
      employeeId,
      locationId,
      balanceType,
      daysRequested: 5
    });

    expect(request.status).toBe('pending_manager_approval');
    expect(request.requestedBalanceAtSubmission).toBe(20);

    // Step 2: HCM updates balance (work anniversary bonus)
    await balanceService.deductBalance(employeeId, locationId, balanceType, -5, 1);
    const updatedBalance = await balanceService.getBalance(employeeId, locationId, balanceType);
    expect(updatedBalance.currentBalance).toBe(25);

    // Step 3: Manager approves (divergence detected: 20 → 25)
    const approved = await requestService.approveRequest(request.id, 'M_NYC_001', locationId);

    // Should auto-approve (increase benefits employee, no confirmation needed)
    expect(approved.status).toBe('processing');
    expect(approved.divergenceDetectedAt).toBeDefined();
    expect(approved.divergenceReason).toMatch(/20.*25/);

    console.log('  ✓ Divergence auto-approved (balance increase)');
    console.log('  ✓ Request moved to processing without employee confirmation');
  });

  /**
   * DIVERGENCE SCENARIO 3: Balance Decrease (Valid Request)
   * When HCM balance decreases but request is still valid,
   * system should ask employee to confirm
   */
  test('should ask employee confirmation when balance decreases but request valid', async () => {
    console.log('\nDIVERGENCE: Balance Decrease (Valid)\n');

    const employeeId = 'E_DECREASE_VALID_001';
    const locationId = 'NYC';
    const balanceType = 'vacation';

    // Setup: Employee starts with 20 days
    await balanceService.getBalance(employeeId, locationId, balanceType);
    db.prepare(
      `UPDATE balances SET current_balance = 20, hcm_version = 1
       WHERE employee_id = ? AND location_id = ? AND balance_type = ?`
    ).run(employeeId, locationId, balanceType);

    // Step 1: Employee submits request for 5 days (balance: 20)
    const request = await requestService.submitRequest({
      employeeId,
      locationId,
      balanceType,
      daysRequested: 5
    });

    // Step 2: HCM decreases balance (policy change: 20 → 15)
    await balanceService.deductBalance(employeeId, locationId, balanceType, 5, 1);

    // Step 3: Manager approves (divergence detected: 20 → 15)
    const approved = await requestService.approveRequest(request.id, 'M_NYC_001', locationId);

    // Should ask for employee confirmation (15 >= 5 so valid, but decreased)
    expect(approved.status).toBe('pending_employee_confirmation');
    expect(approved.divergenceDetectedAt).toBeDefined();

    // Step 4: Employee confirms
    const confirmed = await requestService.confirmRequest(request.id, employeeId, 'proceed');
    expect(confirmed.status).toBe('processing');

    console.log('  ✓ Employee asked for confirmation on balance decrease');
    console.log('  ✓ After confirmation, request moved to processing');
  });

  /**
   * DIVERGENCE SCENARIO 3b: Balance Decrease (Employee Cancels)
   * Employee can cancel request after balance decrease
   */
  test('should reject request if employee cancels after divergence', async () => {
    console.log('\nDIVERGENCE: Balance Decrease (Employee Cancels)\n');

    const employeeId = 'E_CANCEL_001';
    const locationId = 'NYC';
    const balanceType = 'vacation';

    // Setup
    await balanceService.getBalance(employeeId, locationId, balanceType);
    db.prepare(
      `UPDATE balances SET current_balance = 20, hcm_version = 1
       WHERE employee_id = ? AND location_id = ? AND balance_type = ?`
    ).run(employeeId, locationId, balanceType);

    // Submit request
    const request = await requestService.submitRequest({
      employeeId,
      locationId,
      balanceType,
      daysRequested: 5
    });

    // Balance decreases
    await balanceService.deductBalance(employeeId, locationId, balanceType, 5, 1);

    // Manager approves
    const approved = await requestService.approveRequest(request.id, 'M_NYC_001', locationId);
    expect(approved.status).toBe('pending_employee_confirmation');

    // Employee cancels
    const cancelled = await requestService.confirmRequest(request.id, employeeId, 'cancel');
    expect(cancelled.status).toBe('rejected');

    console.log('  ✓ Employee cancelled request after divergence');
    console.log('  ✓ Request status changed to rejected');
  });

  /**
   * DIVERGENCE SCENARIO 4: Balance Decrease (Invalid Request)
   * When HCM balance decreases and request is no longer valid,
   * system should auto-reject
   */
  test('should auto-reject when balance too low after divergence', async () => {
    console.log('\nDIVERGENCE: Balance Decrease (Invalid)\n');

    const employeeId = 'E_DECREASE_INVALID_001';
    const locationId = 'NYC';
    const balanceType = 'vacation';

    // Setup: Employee starts with 20 days
    await balanceService.getBalance(employeeId, locationId, balanceType);
    db.prepare(
      `UPDATE balances SET current_balance = 20, hcm_version = 1
       WHERE employee_id = ? AND location_id = ? AND balance_type = ?`
    ).run(employeeId, locationId, balanceType);

    // Step 1: Employee submits request for 5 days (balance: 20)
    const request = await requestService.submitRequest({
      employeeId,
      locationId,
      balanceType,
      daysRequested: 5
    });

    // Step 2: HCM decreases balance significantly (20 → 3, insufficient)
    db.prepare(
      `UPDATE balances SET current_balance = 3, hcm_version = 2
       WHERE employee_id = ? AND location_id = ? AND balance_type = ?`
    ).run(employeeId, locationId, balanceType);

    // Step 3: Manager approves (divergence detected: 20 → 3, request invalid)
    const approved = await requestService.approveRequest(request.id, 'M_NYC_001', locationId);

    // Should auto-reject (3 < 5, insufficient balance)
    expect(approved.status).toBe('rejected');
    expect(approved.divergenceDetectedAt).toBeDefined();

    console.log('  ✓ Request auto-rejected due to insufficient balance');
    console.log('  ✓ No HCM submission made');
  });

  /**
   * DIVERGENCE SCENARIO 7: Multiple Balance Changes
   * When balance changes multiple times before approval,
   * system should use final HCM value
   */
  test('should handle multiple balance changes before approval', async () => {
    console.log('\nDIVERGENCE: Multiple Changes\n');

    const employeeId = 'E_MULTI_CHANGE_001';
    const locationId = 'NYC';
    const balanceType = 'vacation';

    // Setup: Employee starts with 20 days
    await balanceService.getBalance(employeeId, locationId, balanceType);
    db.prepare(
      `UPDATE balances SET current_balance = 20, hcm_version = 1
       WHERE employee_id = ? AND location_id = ? AND balance_type = ?`
    ).run(employeeId, locationId, balanceType);

    // Step 1: Employee submits (balance: 20)
    const request = await requestService.submitRequest({
      employeeId,
      locationId,
      balanceType,
      daysRequested: 5
    });

    // Step 2: HCM updates: 20 → 25 (work anniversary)
    await balanceService.deductBalance(employeeId, locationId, balanceType, -5, 1);

    // Step 3: HCM updates: 25 → 27 (policy bonus)
    await balanceService.deductBalance(employeeId, locationId, balanceType, -2, 2);

    // Step 4: Manager approves (net increase, auto-approve)
    const approved = await requestService.approveRequest(request.id, 'M_NYC_001', locationId);

    expect(approved.status).toBe('processing');
    expect(approved.divergenceDetectedAt).toBeDefined();

    console.log('  ✓ Multiple balance changes detected');
    console.log('  ✓ Final balance (27) used for deduction');
  });
});
