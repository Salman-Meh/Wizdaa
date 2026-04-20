# Time-Off Microservice - Test Suite Specification

## Overview

This document specifies all test cases for the Time-Off Microservice. Tests follow a **Test-Driven Development (TDD)** approach: test specifications come first, implementation follows.

### Test Statistics
- **Unit Tests**: 80+ test cases across 4 services
- **Integration Tests**: 27+ test cases across 12 workflows (includes 5 multi-location scenarios)
- **Edge Case Tests**: 15+ test cases (includes 8 multi-location edge cases)
- **Total Test Cases**: 120+ cases
- **Target Coverage**: 85% overall, 95% for service logic

### Testing Tools
- **Framework**: Jest
- **Mocking**: Jest mock objects
- **Database**: SQLite (in-memory for tests)
- **Mock HCM**: Standalone mock server (~400 lines)

---

## 1. Test Setup & Infrastructure

### 1.1 Test Database Setup
```typescript
describe('Database Setup', () => {
  test('should initialize SQLite database with all tables', async () => {
    // Verify tables exist: balances, requests, audit_logs
    // Verify indexes are created
    // Verify constraints are enforced
  });

  test('should create UNIQUE constraint on (employee_id, location_id, balance_type)', async () => {
    // Insert two records with same dimensions
    // Expect second insert to fail
  });

  test('should have proper indexes for query performance', async () => {
    // Verify idx_employee, idx_location, idx_status indexes exist
    // Verify query performance with indexes
  });

  test('should support transactions for atomic updates', async () => {
    // Begin transaction
    // Update balance and request in same transaction
    // Verify both succeed or both fail
  });
});
```

### 1.2 Mock HCM Server Setup
```typescript
describe('Mock HCM Server', () => {
  test('should start mock HCM server on configured port', async () => {
    // Start server
    // Verify it responds to /health
    // Verify port is correct
  });

  test('should handle real-time API requests', async () => {
    // GET /api/balances/{employeeId}/{locationId}
    // Return balance, hcm_version, lastUpdatedAt
  });

  test('should handle batch API requests', async () => {
    // GET /api/balances/batch
    // Return all balances for all employees
  });

  test('should support configurable responses', async () => {
    // Force error responses
    // Force delays
    // Set deterministic values
  });

  test('should track request submissions and polling', async () => {
    // POST /api/submissions
    // Return submission ID, status: "received"
    // Track submission for later polling
  });

  test('should support test utilities', async () => {
    // forceApprove(submissionId)
    // forceReject(submissionId)
    // reset()
    // getSubmissionHistory()
  });
});
```

---

## 2. BalanceService Unit Tests

### 2.1 Get Balance Tests
```typescript
describe('BalanceService.getBalance', () => {
  test('should return balance from cache if exists and not stale', async () => {
    // Mock Redis with balance, TTL=1 hour
    // Call getBalance
    // Verify no HCM call made
    // Verify balance returned
  });

  test('should fetch from HCM if cache miss', async () => {
    // Clear Redis cache
    // Mock HCM real-time API to return {balance: 20, hcm_version: 5}
    // Call getBalance
    // Verify HCM called with employee_id and location_id
    // Verify balance returned: 20
  });

  test('should update local cache after HCM fetch', async () => {
    // Cache miss: fetch from HCM
    // Verify Redis updated with new balance and TTL
    // Verify SQLite updated with new balance and last_synced_at
  });

  test('should detect divergence between cache and HCM', async () => {
    // SQLite has balance: 20
    // HCM returns balance: 25
    // Log divergence event
    // Return HCM value (source of truth)
  });

  test('should handle HCM timeout gracefully', async () => {
    // Mock HCM to timeout (>5 seconds)
    // Should fall back to SQLite value
    // Log timeout event
    // Return SQLite balance (stale, but better than error)
  });

  test('should handle HCM 404 (employee not found)', async () => {
    // Mock HCM: 404 Employee not found
    // Should reject with clear error
    // Verify error message includes employee_id and location_id
  });

  test('should handle HCM errors (5xx)', async () => {
    // Mock HCM: 500 Internal error
    // Should retry up to 3 times with exponential backoff
    // After 3 retries, return SQLite value (stale)
    // Log error and retry attempts
  });

  test('should return balance with source metadata', async () => {
    // Response should include:
    // - current_balance: number
    // - source: "hcm" | "cache" | "stale"
    // - lastSynced: timestamp
    // - hcm_version: number
  });
});
```

### 2.2 Deduct Balance Tests
```typescript
describe('BalanceService.deductBalance', () => {
  test('should deduct amount from balance', async () => {
    // Current balance: 20
    // Deduct: 5
    // Result: 15
    // Verify update in SQLite
  });

  test('should use optimistic locking to prevent race conditions', async () => {
    // Balance: {id: 1, balance: 20, hcm_version: 5}
    // Update with hcm_version=5: new balance=15, hcm_version=6
    // Verify WHERE clause includes version check
    // Verify version incremented
  });

  test('should fail if version mismatch (concurrent modification)', async () => {
    // Balance: {id: 1, balance: 20, hcm_version: 5}
    // Update with hcm_version=4 (stale)
    // Should throw VersionMismatchError
    // Verify no update occurred
    // Caller should retry with fresh version
  });

  test('should reject deduction if balance insufficient', async () => {
    // Current balance: 3
    // Request deduction: 5
    // Should throw InsufficientBalanceError
    // Verify no update occurred
  });

  test('should update last_synced_at timestamp', async () => {
    // Before deduction: last_synced_at = 2 hours ago
    // After deduction: last_synced_at = now
  });

  test('should create audit log for each deduction', async () => {
    // Verify audit_logs entry created with:
    // - entity_type: "balance"
    // - entity_id: balance_id
    // - event_type: "deducted"
    // - details: {amount: 5, previous_balance: 20, new_balance: 15}
  });

  test('should handle concurrent deductions (race condition)', async () => {
    // Scenario: Two concurrent deductions on same balance
    // Thread 1: Deduct 5 from 20 (version 5 → 6)
    // Thread 2: Deduct 3 from 20 (version 5 → 6)
    // Thread 1 succeeds: balance = 15, version = 6
    // Thread 2 fails: version mismatch (expected 5, actual 6)
    // Verify final balance is 15 (not 12), no double-deduction
  });

  test('should support refund (negative deduction)', async () => {
    // Current balance: 15
    // Deduct: -5 (refund)
    // Result: 20
    // Verify audit log shows "refunded" event
  });
});
```

### 2.3 Update Balance Tests
```typescript
describe('BalanceService.updateBalance', () => {
  test('should update balance via batch sync', async () => {
    // Simulate daily batch sync: update 50k+ employees
    // Input: Array of {employee_id, location_id, balance_type, new_balance, hcm_version}
    // Verify all records updated in SQLite
    // Verify last_synced_at updated for all
  });

  test('should batch process updates in chunks', async () => {
    // Update 50k employees
    // Should process in chunks of 1000 (configurable)
    // Verify all chunks completed
    // Verify no database lock contention
  });

  test('should detect divergences during batch sync', async () => {
    // Batch sync updates balance: 20 → 25
    // Verify divergence detected and logged
    // Verify notification queued for employee
  });

  test('should log all changes in audit trail', async () => {
    // For each balance update:
    // - Create audit_logs entry
    // - Include previous and new values
    // - Include hcm_version for traceability
  });

  test('should handle partial batch failures', async () => {
    // 100 updates, 1 fails due to constraint violation
    // Should complete 99 updates
    // Should retry failed update
    // Should log failure reason
  });
});
```

---

## 3. RequestService Unit Tests

### 3.1 Submit Request Tests
```typescript
describe('RequestService.submitRequest', () => {
  test('should create request with pending_manager_approval status', async () => {
    // Submit: {employeeId: E1, locationId: L1, balanceType: "vacation", daysRequested: 5}
    // Verify request created with:
    // - status: "pending_manager_approval"
    // - requested_balance_at_submission: 20 (captured at submission time)
    // - created_at: now
  });

  test('should validate employee has sufficient balance', async () => {
    // Balance: 3 days
    // Request: 5 days
    // Should reject with InsufficientBalanceError
    // Verify no request created
  });

  test('should validate employee exists', async () => {
    // Submit for non-existent employee
    // Should reject with EmployeeNotFoundError
  });

  test('should validate location exists', async () => {
    // Submit for non-existent location
    // Should reject with LocationNotFoundError
  });

  test('should validate balance type is valid', async () => {
    // Valid types: "vacation", "sick", "personal"
    // Invalid type: "sabbatical"
    // Should reject with InvalidBalanceTypeError
  });

  test('should capture balance snapshot at submission time', async () => {
    // Balance: 20
    // Submit request for 5
    // Store requested_balance_at_submission: 20
    // Later, balance changes to 25 (HCM update)
    // When manager approves, detect divergence (20 → 25)
  });

  test('should call HCM real-time API to verify balance', async () => {
    // Submit request
    // Should call HCM: GET /api/balances/E1/L1
    // Should verify HCM agrees on balance
    // Store HCM response (hcm_version)
  });

  test('should create audit log for submission', async () => {
    // Verify audit_logs entry:
    // - event_type: "request_submitted"
    // - details: {employee_id, days_requested, balance_at_submission}
  });

  test('should return request ID and status to employee', async () => {
    // Response: {requestId: "REQ-123", status: "pending_manager_approval"}
    // Employee can use requestId to check status later
  });
});
```

### 3.2 Approve Request Tests
```typescript
describe('RequestService.approveRequest', () => {
  test('should transition request from pending_manager_approval to processing', async () => {
    // Initial status: pending_manager_approval
    // Approve
    // Status → processing
    // Store manager_id, manager_action_at
  });

  test('should verify balance has not diverged since submission', async () => {
    // Submission: balance = 20
    // Approval: fetch current balance = 20
    // Match ✓ → proceed to processing
  });

  test('should detect divergence if balance increased', async () => {
    // Submission: balance = 20
    // Approval: current balance = 25 (HCM work anniversary)
    // Divergence detected ✓
    // Status → pending_employee_confirmation
    // Notify employee with details of change
  });

  test('should detect divergence if balance decreased', async () => {
    // Submission: balance = 20
    // Approval: current balance = 15 (HCM policy change)
    // Divergence detected ✓
    // Status → pending_employee_confirmation
    // Notify employee: "Your balance decreased. Still want to proceed?"
  });

  test('should reject if balance too low after divergence decrease', async () => {
    // Submission: balance = 20, request = 5
    // Approval: balance = 3 (decrease)
    // Request valid? 3 >= 5? NO
    // Auto-reject request
    // Status → rejected
    // Notify employee: "Your balance no longer supports this request"
  });

  test('should queue HCM submission job when balance matches', async () => {
    // No divergence → proceed to processing
    // Queue background job: submitToHCM(request_id)
    // Status → processing
  });

  test('should create audit log for approval', async () => {
    // event_type: "request_approved" or "divergence_detected"
    // details: {manager_id, divergence_reason (if applicable)}
  });

  test('should reject if request not in pending_manager_approval state', async () => {
    // Try to approve already-approved request
    // Should reject with InvalidStateError
  });

  test('should reject if manager not authorized', async () => {
    // Employee submits, employee tries to approve own request
    // Should reject with UnauthorizedError
    // Manager must be the employee's reporting manager
  });
});
```

### 3.3 Confirm Request (Divergence) Tests
```typescript
describe('RequestService.confirmRequest', () => {
  test('should accept "proceed" action and submit to HCM', async () => {
    // Status: pending_employee_confirmation (divergence detected)
    // Employee action: "proceed"
    // Status → processing
    // Queue HCM submission job
  });

  test('should accept "cancel" action and reject request', async () => {
    // Status: pending_employee_confirmation
    // Employee action: "cancel"
    // Status → rejected
    // No HCM submission
    // No balance change
    // Notify manager: request cancelled by employee
  });

  test('should reject if request not in pending_employee_confirmation state', async () => {
    // Try to confirm request that is not awaiting confirmation
    // Should reject with InvalidStateError
  });

  test('should verify employee is the request owner', async () => {
    // Employee A submits request
    // Employee B tries to confirm
    // Should reject with UnauthorizedError
  });

  test('should create audit log for confirmation action', async () => {
    // event_type: "request_confirmed" or "request_cancelled"
    // details: {employee_action, confirmation_time}
  });
});
```

### 3.4 Get Request Status Tests
```typescript
describe('RequestService.getStatus', () => {
  test('should return request status with all details', async () => {
    // Response includes:
    // - requestId
    // - status: "pending_manager_approval" | "processing" | "approved" | "rejected" | "pending_employee_confirmation"
    // - employeeId, locationId, balanceType, daysRequested
    // - manager approval details (if approved)
    // - divergence details (if applicable)
    // - approvedAt, rejectedAt (if terminal state)
  });

  test('should return different data based on status', async () => {
    // pending_manager_approval: show approval status
    // pending_employee_confirmation: show divergence details, action options
    // processing: show HCM status, polling info
    // approved/rejected: show outcome details
  });

  test('should include balance remaining after approval', async () => {
    // Submitted: balance = 20, request = 5
    // Approved: balanceRemaining = 15 (if approved)
  });
});
```

---

## 4. HCMSyncService Unit Tests

### 4.1 Real-Time Balance Fetch Tests
```typescript
describe('HCMSyncService.fetchBalance', () => {
  test('should call HCM real-time API for current balance', async () => {
    // Call: fetchBalance(employeeId, locationId)
    // HCM API: GET /api/balances/{employeeId}/{locationId}
    // Expect response: {balance: 20, hcm_version: 5, lastUpdatedAt: timestamp}
  });

  test('should return balance with HCM version', async () => {
    // Response should include hcm_version for optimistic locking
  });

  test('should handle HCM API timeout (>5 seconds)', async () => {
    // Mock HCM to timeout
    // Should throw TimeoutError
    // Caller decides whether to use stale value or fail
  });

  test('should handle HCM 404 (employee/location not found)', async () => {
    // Throw EmployeeNotFoundError with clear message
  });

  test('should cache result for 1 hour', async () => {
    // First call: fetch from HCM
    // Second call (within 1 hour): return from cache
    // Third call (after 1 hour): fetch from HCM again
  });

  test('should retry on transient HCM errors', async () => {
    // HCM returns 503 (Service Unavailable)
    // Retry with exponential backoff (50ms, 100ms, 200ms)
    // After 3 retries, throw error
  });
});
```

### 4.2 Batch Sync Tests
```typescript
describe('HCMSyncService.batchSync', () => {
  test('should fetch all employee balances from HCM batch API', async () => {
    // Call: batchSync()
    // HCM API: GET /api/balances/batch
    // Returns: Array of {employee_id, location_id, balance_type, balance, hcm_version}
  });

  test('should process 50k+ employees without timeout', async () => {
    // Batch API call should complete in <10 seconds
    // No pagination (API handles it)
  });

  test('should implement clustering if batch API timeout risk', async () => {
    // If timeout: Call batch API for 10k employees at a time
    // Sequence clusters 5 minutes apart
    // Verify all 50k employees processed
  });

  test('should compare HCM balances to local balances', async () => {
    // HCM: Employee E1 = 25 days
    // Local: Employee E1 = 20 days
    // Divergence detected → log and reconcile
  });

  test('should update SQLite with HCM balances', async () => {
    // For each employee:
    // - Update balance
    // - Update hcm_version
    // - Update last_synced_at
  });

  test('should detect new employees added in HCM', async () => {
    // HCM has 50,010 employees
    // Local has 50,000 employees
    // Should create 10 new balance records
  });

  test('should log all changes in audit trail', async () => {
    // For each changed balance:
    // - event_type: "batch_sync_update"
    // - details: {previous_balance, new_balance, hcm_version}
  });

  test('should queue employee notifications for balance changes', async () => {
    // If employee E1 balance increases: Notify "You received bonus days"
    // If employee E1 balance decreases: Notify "Your balance was updated"
  });

  test('should complete within off-peak window (2 AM - 6 AM)', async () => {
    // Batch sync scheduled for 2 AM
    // Should complete by 6 AM even with clustering
  });
});
```

### 4.3 Submit to HCM Tests
```typescript
describe('HCMSyncService.submitToHCM', () => {
  test('should submit approved request to HCM', async () => {
    // Call: submitToHCM(request_id)
    // HCM API: POST /api/submissions
    // Payload: {employee_id, location_id, balance_type, days_requested}
    // Response: {submissionId: "HCM-789", status: "received"}
  });

  test('should store HCM submission ID for tracking', async () => {
    // Update requests table:
    // - hcm_submission_id: "HCM-789"
    // - submitted_to_hcm_at: now
    // - status: "processing"
  });

  test('should queue polling job after submission', async () => {
    // After successful submission:
    // - Queue: pollHCMStatus(request_id) every 5 seconds
    // - Stop polling when terminal state reached
  });

  test('should handle HCM submission errors', async () => {
    // HCM returns error: "Insufficient balance"
    // Should reject request
    // Status → rejected
    // Notify employee: "HCM rejected your request"
  });

  test('should retry submission on transient errors', async () => {
    // HCM returns 503 (Service Unavailable)
    // Retry up to 3 times with exponential backoff
    // If all retries fail: Log and alert, status → stuck
  });

  test('should be idempotent', async () => {
    // Submit same request twice
    // Should return same submissionId
    // Not create duplicate submissions
    // (HCM should deduplicate by request_id)
  });
});
```

### 4.4 Poll HCM Status Tests
```typescript
describe('HCMSyncService.pollHCMStatus', () => {
  test('should poll HCM for request status every 5 seconds', async () => {
    // Call: pollHCMStatus(request_id)
    // Loop every 5 seconds: GET /api/submissions/{submissionId}
    // Response: {status: "processing" | "approved" | "rejected"}
  });

  test('should update request status when HCM responds "approved"', async () => {
    // HCM: "Approved"
    // Update requests table:
    // - status: "approved"
    // - hcm_approved_at: now
    // Deduct balance
    // Stop polling
  });

  test('should update request status when HCM responds "rejected"', async () => {
    // HCM: "Rejected" (insufficient balance, etc.)
    // Update requests table:
    // - status: "rejected"
    // - divergence_reason: "HCM rejected: {reason}"
    // Do NOT deduct balance
    // Notify employee: "Your request was rejected"
    // Stop polling
  });

  test('should deduct balance when request approved', async () => {
    // Current balance: 20
    // Approved request: 5 days
    // Deduct: 20 - 5 = 15
    // Use optimistic locking (hcm_version must match)
  });

  test('should handle deduction failure (balance diverged)', async () => {
    // HCM approved request
    // Try to deduct: hcm_version mismatch
    // Should trigger divergence recovery
    // Log inconsistency for investigation
  });

  test('should stop polling after timeout (1 hour)', async () => {
    // Polling starts
    // After 1 hour of "processing" status:
    // - Stop polling
    // - Flag request as "stuck"
    // - Alert manager: "Request still processing after 1 hour"
    // - Nightly job will do final check at 24 hours
  });

  test('should retry on transient HCM errors', async () => {
    // HCM returns 503
    // Retry after 5 seconds (continue normal polling)
    // If repeated errors: Log but continue polling
  });

  test('should create audit log for each poll', async () => {
    // event_type: "hcm_poll"
    // details: {hcm_status, polling_attempt_number}
    // (Log once every 5-10 polls to avoid spam, or only on status change)
  });
});
```

---

## 5. DivergenceService Unit Tests

### 5.1 Detect Divergence Tests
```typescript
describe('DivergenceService.detectDivergence', () => {
  test('should detect balance increase during manager approval', async () => {
    // Submitted balance: 20
    // Current balance: 25
    // Should return: {diverged: true, previous: 20, current: 25, type: "increase"}
  });

  test('should detect balance decrease during manager approval', async () => {
    // Submitted balance: 20
    // Current balance: 15
    // Should return: {diverged: true, previous: 20, current: 15, type: "decrease"}
  });

  test('should detect no divergence if balance matches', async () => {
    // Submitted balance: 20
    // Current balance: 20
    // Should return: {diverged: false}
  });

  test('should determine if request is still valid after decrease', async () => {
    // Submitted: 20, Request: 5
    // Current: 15
    // 15 >= 5? YES → request still valid
    // Should return: {valid: true}
  });

  test('should determine if request is invalid after decrease', async () => {
    // Submitted: 20, Request: 5
    // Current: 3
    // 3 >= 5? NO → request no longer valid
    // Should return: {valid: false}
  });
});
```

### 5.2 Auto-Reconciliation Tests
```typescript
describe('DivergenceService.autoReconcile', () => {
  test('should auto-reconcile if increase (employee gains benefit)', async () => {
    // Divergence: 20 → 25 (increase)
    // Should auto-approve without employee confirmation
    // Proceed with HCM submission
  });

  test('should NOT auto-reconcile if decrease (employee loses benefit)', async () => {
    // Divergence: 20 → 15 (decrease)
    // Should pause and ask employee
    // Notify: "Your balance decreased. Still want to proceed?"
    // Wait for employee decision
  });

  test('should auto-reject if decrease makes request invalid', async () => {
    // Divergence: 20 → 3, Request: 5
    // 3 < 5? YES
    // Auto-reject without employee confirmation
    // Status → rejected
    // Notify employee: "Your balance no longer supports this request"
  });

  test('should queue employee notification for divergence', async () => {
    // Divergence detected → Queue notification
    // Message: "Your balance changed. Do you want to proceed?"
    // Include: previous balance, new balance, requested amount
  });
});
```

---

## 6. Integration Tests

### 6.1 Happy Path Workflow
```typescript
describe('Integration: Happy Path (No Divergence)', () => {
  test('should complete request from submission to approval', async () => {
    // 1. Employee submits: 5 days vacation (balance: 20)
    // 2. System: validates balance (20 >= 5 ✓), calls HCM (20 ✓)
    // 3. Request status: pending_manager_approval
    // 4. Manager approves
    // 5. System: checks balance (20 == 20 ✓)
    // 6. Status: processing
    // 7. Background: submits to HCM
    // 8. HCM: approves
    // 9. Worker: polls, gets "approved"
    // 10. System: deducts balance (20 - 5 = 15)
    // 11. Status: approved
    // 12. Verify: audit trail complete, employee notified
  });

  test('should handle concurrent submissions for same employee', async () => {
    // Employee E1 submits two requests simultaneously
    // Request 1: 5 days
    // Request 2: 3 days
    // Balance: 20
    // Both valid? YES
    // Both should be created (status: pending_manager_approval)
    // Manager approves both
    // System processes in order:
    // - Req 1: 20 → 15 (approved)
    // - Req 2: 15 → 12 (approved)
    // Verify no race conditions, balances correct
  });

  test('should generate complete audit trail', async () => {
    // After happy path completion:
    // - request_submitted
    // - hcm_balance_verified
    // - request_approved
    // - hcm_submitted
    // - hcm_poll (multiple)
    // - hcm_approved
    // - balance_deducted
    // - request_completed
  });
});
```

### 6.2 Divergence + Balance Increase
```typescript
describe('Integration: Divergence with Balance Increase', () => {
  test('should auto-approve divergence when balance increases', async () => {
    // 1. Employee submits: 5 days (balance: 20)
    // 2. Request: pending_manager_approval
    // 3. HCM updates: work anniversary, balance: 25
    // 4. Manager approves (after HCM update)
    // 5. System: fetches current balance (25)
    // 6. Divergence detected: 20 → 25
    // 7. Type: increase (employee benefit)
    // 8. Auto-reconcile: proceed with submission
    // 9. Status: processing (no employee confirmation needed)
    // 10. HCM approves
    // 11. Deduct: 25 - 5 = 20
    // 12. Notify employee: "Your balance increased. Request approved."
  });

  test('should update balance to HCM value', async () => {
    // Submitted balance snapshot: 20
    // HCM current balance: 25
    // Update local balance to 25
    // Use HCM's hcm_version for future optimistic locking
  });
});
```

### 6.3 Divergence + Balance Decrease (Valid Request)
```typescript
describe('Integration: Divergence with Balance Decrease (Valid)', () => {
  test('should pause and ask employee when balance decreases but request still valid', async () => {
    // 1. Employee submits: 5 days (balance: 20)
    // 2. HCM updates: policy change, balance: 15
    // 3. Manager approves (after HCM update)
    // 4. System: fetches balance (15)
    // 5. Divergence: 20 → 15 (decrease)
    // 6. Valid? 15 >= 5? YES
    // 7. Status: pending_employee_confirmation
    // 8. Notify employee:
    //    "Your balance decreased from 20 to 15 days.
    //     You requested 5 days.
    //     [Proceed] [Cancel]"
    // 9. Employee clicks [Proceed]
    // 10. Status: processing
    // 11. Submit to HCM
    // 12. HCM approves
    // 13. Deduct: 15 - 5 = 10
    // 14. Notify: "Request approved with updated balance"
  });

  test('should handle employee cancellation after divergence', async () => {
    // Same setup as above, but employee clicks [Cancel]
    // Status: rejected
    // No HCM submission
    // No balance change
    // Notify manager: "Request cancelled by employee due to balance change"
  });
});
```

### 6.4 Divergence + Balance Decrease (Invalid Request)
```typescript
describe('Integration: Divergence with Balance Decrease (Invalid)', () => {
  test('should auto-reject when balance too low', async () => {
    // 1. Employee submits: 5 days (balance: 20)
    // 2. HCM updates: policy change, balance: 3
    // 3. Manager approves
    // 4. System: fetches balance (3)
    // 5. Divergence: 20 → 3
    // 6. Valid? 3 >= 5? NO
    // 7. Auto-reject: status → rejected
    // 8. No HCM submission
    // 9. No balance change
    // 10. Notify employee:
    //     "Your balance is no longer sufficient for this request.
    //      You have 3 days, requested 5."
    // 11. Notify manager: "Request auto-rejected due to insufficient balance"
  });
});
```

### 6.5 Manager Rejection
```typescript
describe('Integration: Manager Rejects Request', () => {
  test('should reject request without HCM submission', async () => {
    // 1. Employee submits: 5 days
    // 2. Request: pending_manager_approval
    // 3. Manager rejects with reason: "Need coverage on those dates"
    // 4. Status: rejected
    // 5. No HCM submission
    // 6. No balance change
    // 7. Notify employee: "Your request was rejected: Need coverage on those dates"
    // 8. Audit: reason logged
  });
});
```

### 6.6 Stuck Request Recovery
```typescript
describe('Integration: Stuck Request Recovery (24+ hours)', () => {
  test('should recover stuck request via nightly job', async () => {
    // Day 1, 10 AM:
    // 1. Employee submits
    // 2. Manager approves
    // 3. System submits to HCM
    // 4. Worker polls every 5 seconds
    // 5. HCM: "Processing..." (stuck)
    // 
    // Day 1, 11 AM:
    // 6. After 1 hour of polling: Give up
    // 7. Alert manager: "Request still processing after 1 hour"
    // 8. Status remains: processing
    // 
    // Day 2, 2 AM:
    // 9. Nightly recovery job runs
    // 10. Finds requests >24 hours in processing
    // 11. Calls HCM: "Status of submission HCM-789?"
    // 12. HCM: "Approved"
    // 13. System: Deduct balance
    // 14. Status: approved
    // 15. Audit: "Recovered by nightly job"
    // 16. Notify employee: "Your request was approved"
  });

  test('should handle nightly job finding rejection', async () => {
    // Same as above, but HCM returns "Rejected"
    // Status: rejected
    // No balance deduction
    // Notify employee: "Your request was rejected"
  });

  test('should log recovery for investigation', async () => {
    // Nightly job completes recovery
    // Audit entry includes:
    // - original_submission_time: Day 1, 10:11 AM
    // - recovery_time: Day 2, 2:00 AM
    // - hcm_final_status: "Approved" | "Rejected"
  });
});
```

### 6.7 Request With Multiple Divergences
```typescript
describe('Integration: Multiple Divergences During Review', () => {
  test('should handle balance changes multiple times before approval', async () => {
    // T=0:    Employee submits (balance: 20)
    // T=30m:  HCM updates: 20 → 25 (work anniversary)
    // T=45m:  HCM updates: 25 → 27 (policy bonus)
    // T=60m:  Manager approves
    // System should:
    // 1. Fetch current balance: 27
    // 2. Compare to snapshot: 20
    // 3. Divergence detected: 20 → 27 (net increase)
    // 4. Auto-approve (increase benefits employee)
    // 5. Use HCM's current balance (27) for deduction
    // 6. Deduct: 27 - 5 = 22
  });
});
```

### 6.8 Multi-Location Employee - Concurrent Requests
```typescript
describe('Integration: Multi-Location Employee - Concurrent Requests', () => {
  test('should handle concurrent requests from different locations independently', async () => {
    // Employee John works at NYC and LA
    // John submits request from NYC: 5 days vacation (NYC balance: 20)
    // John submits request from LA: 3 days vacation (LA balance: 15)
    // 
    // NYC Manager (Sarah) approves NYC request
    // LA Manager (Mike) approves LA request
    //
    // Expected:
    // 1. NYC request → processing
    // 2. LA request → processing
    // 3. NYC HCM submission succeeds: 20 - 5 = 15
    // 4. LA HCM submission succeeds: 15 - 3 = 12
    // 5. Final: NYC=15, LA=12 (independent deductions)
    // 6. Verify: No cross-location interference
  });

  test('should maintain independent hcm_version per location', async () => {
    // NYC balance: {version: 5}
    // LA balance: {version: 3}
    // 
    // NYC request deduction: version 5 → 6
    // LA request deduction: version 3 → 4
    // 
    // Both succeed independently
    // Verify: NYC version=6, LA version=4
  });
});
```

### 6.9 Multi-Location Employee - Manager Authorization
```typescript
describe('Integration: Multi-Location Manager Authorization', () => {
  test('should reject approval from manager of wrong location', async () => {
    // Employee John at LA submits request
    // John's NYC Manager (Sarah) tries to approve
    // 
    // System:
    // 1. Fetch request: locationId = "LA"
    // 2. Fetch manager: locationId = "NYC"
    // 3. Verify: "NYC" != "LA" → MISMATCH
    // 4. Reject with UnauthorizedError
    // 5. Message: "Manager from NYC cannot approve requests for LA"
  });

  test('should accept approval from manager of correct location', async () => {
    // Employee John at NYC submits request
    // John's NYC Manager (Sarah) approves
    // 
    // System:
    // 1. Fetch request: locationId = "NYC"
    // 2. Fetch manager: locationId = "NYC"
    // 3. Verify: "NYC" == "NYC" → MATCH ✓
    // 4. Proceed with approval
  });

  test('should handle employee with multiple managers (one per location)', async () => {
    // Employee John:
    // - NYC: Manager Sarah
    // - LA: Manager Mike
    // - Chicago: Manager Lisa
    // 
    // NYC request → approved by Sarah ✓
    // LA request → approved by Mike ✓
    // Chicago request → approved by Lisa ✓
    // 
    // Each manager can only approve their location
  });
});
```

### 6.10 Multi-Location Employee - Get Balance
```typescript
describe('Integration: Multi-Location - Get All Balances', () => {
  test('should return all balances for multi-location employee', async () => {
    // Employee John at 3 locations:
    // - NYC: vacation=20, sick=10, personal=5
    // - LA: vacation=15, sick=8, personal=3
    // - Chicago: vacation=18, sick=9, personal=4
    // 
    // GET /api/balances/john
    // Response should include:
    // {
    //   employeeId: "john",
    //   locations: [
    //     { locationId: "NYC", balances: {vacation: 20, sick: 10, personal: 5} },
    //     { locationId: "LA", balances: {vacation: 15, sick: 8, personal: 3} },
    //     { locationId: "Chicago", balances: {vacation: 18, sick: 9, personal: 4} }
    //   ]
    // }
  });

  test('should verify freshness per location', async () => {
    // Employee with 3 locations
    // GET /api/balances/john
    // 
    // System calls HCM real-time API:
    // - NYC: Fetches, updates cache, lastSynced=now
    // - LA: Cache hit (within 1 hour), uses cached value
    // - Chicago: Timeout (>5 sec), uses SQLite (stale but better than error)
    // 
    // Response includes per-location lastSynced timestamps
  });

  test('should handle location-specific API failures gracefully', async () => {
    // Employee John with 3 locations
    // GET /api/balances/john
    // 
    // NYC: HCM succeeds
    // LA: HCM 404 (location doesn't exist for John)
    // Chicago: HCM 503 (temporary error)
    // 
    // System should:
    // 1. NYC: Include with fresh data
    // 2. LA: Log error, exclude from response or mark as unavailable
    // 3. Chicago: Use stale SQLite data, mark as stale
    // 4. Return partial response with status per location
  });
});
```

### 6.11 Multi-Location - Batch Sync with Partial Failures
```typescript
describe('Integration: Batch Sync - Location-Aware Partial Failures', () => {
  test('should handle batch sync success for some locations, failure for others', async () => {
    // Batch sync attempts to update all locations:
    // - NYC: Success (10k employees, 5 seconds)
    // - LA: Success (8k employees, 4 seconds)
    // - Chicago: Timeout after 2 seconds (in-flight)
    // - Denver: Success (7k employees, 3 seconds)
    // 
    // System should:
    // 1. NYC: Update all balances, set last_synced_at = now ✓
    // 2. LA: Update all balances, set last_synced_at = now ✓
    // 3. Chicago: Do NOT update (timeout), last_synced_at = old time ✗
    // 4. Denver: Update all balances, set last_synced_at = now ✓
    // 
    // Result: No error thrown, partial sync completed
    // Retry Chicago on next cycle
  });

  test('should retry failed location independently', async () => {
    // Day 1, 2:00 AM: Batch sync attempt
    // - NYC: Success
    // - LA: Timeout
    // 
    // Day 1, 2:15 AM: Retry job
    // - LA: Success (retry just LA, not whole batch)
    // 
    // Verify: LA updated independently without re-syncing NYC
  });

  test('should not treat single location failure as full sync failure', async () => {
    // Batch sync: 1 of 10 locations fails
    // System treats as: "Partial sync succeeded"
    // Not as: "Full sync failed"
    // 
    // Server continues serving requests normally
    // No "sync failed" alerts or rollbacks
    // Only alert if ALL locations fail
  });

  test('should track last_synced_at per location', async () => {
    // NYC: last_synced_at = 2:00 AM
    // LA: last_synced_at = 1:55 AM (old)
    // Chicago: last_synced_at = 2:00 AM
    // 
    // Query should show staleness per location:
    // NYC: fresh (2 hours), LA: stale (2+ hours), Chicago: fresh (2 hours)
  });
});
```

### 6.12 Multi-Location - Divergence Detection Per Location
```typescript
describe('Integration: Divergence Detection - Per Location', () => {
  test('should detect divergence independently for each location', async () => {
    // Employee John at NYC and LA
    // 
    // NYC Request:
    // - Submitted: 20 days
    // - Current: 25 days (HCM work anniversary)
    // - Divergence: YES (increase, auto-approve)
    // 
    // LA Request (concurrent):
    // - Submitted: 15 days
    // - Current: 15 days
    // - Divergence: NO
    // 
    // Result:
    // - NYC: Auto-approved (divergence detected but favorable)
    // - LA: Normal approval (no divergence)
  });

  test('should handle divergence in one location without affecting other', async () => {
    // NYC Request:
    // - Submitted: 20 days
    // - Current: 3 days (policy change)
    // - Divergence: YES (decrease, invalid)
    // - Status: Auto-rejected
    // 
    // LA Request (concurrent):
    // - Submitted: 15 days
    // - Current: 15 days
    // - Divergence: NO
    // - Status: Processing normally
    // 
    // Verify: NYC rejection doesn't affect LA approval
  });
});
```

---

## 7. Edge Case Tests

### 7.1 Race Condition Tests
```typescript
describe('Edge Cases: Race Conditions', () => {
  test('should prevent double-deduction with optimistic locking', async () => {
    // Scenario: Two concurrent request approvals for same employee
    // Request 1: Deduct 5 (version 5 → 6)
    // Request 2: Deduct 3 (version 5 → 6)
    // Balance: 20, hcm_version: 5
    // Thread 1 succeeds: 20 - 5 = 15, version: 6
    // Thread 2 fails: version mismatch (expected 5, actual 6)
    // Caller should retry with fresh balance (15)
    // Final: 15 - 3 = 12 (correct, no double-deduction)
  });

  test('should handle concurrent batch sync and request submission', async () => {
    // Batch sync running: updating all employee balances
    // Concurrent: Employee submits request
    // System should:
    // 1. Lock batch sync updates vs. request deductions
    // 2. Use transaction to ensure consistency
    // 3. No lost updates
  });
});
```

### 7.2 Error Handling Tests
```typescript
describe('Edge Cases: Error Scenarios', () => {
  test('should handle HCM being down during submission', async () => {
    // Employee submits
    // System calls HCM to verify balance
    // HCM is down (connection timeout)
    // Should use local cache/SQLite value (defensive)
    // Proceed with submission using last known balance
    // Log uncertainty for investigation
  });

  test('should handle database lock timeout', async () => {
    // Concurrent updates causing lock contention
    // Retry logic with exponential backoff
    // After max retries: Return error to user
    // Log event for investigation
  });

  test('should handle invalid request state transitions', async () => {
    // Try to approve already-rejected request
    // Should throw InvalidStateError
    // Provide helpful error message
  });

  test('should handle missing employee in authorization', async () => {
    // Request claims to be from employee E1
    // Employee E1 doesn't exist in system
    // Reject with UnauthorizedError
  });
});
```

### 7.3 Boundary Tests
```typescript
describe('Edge Cases: Boundary Conditions', () => {
  test('should handle zero balance', async () => {
    // Balance: 0
    // Request: 1 day
    // Should reject: InsufficientBalanceError
  });

  test('should handle fractional days', async () => {
    // Request: 0.5 days (half-day)
    // Balance: 20
    // Should allow if supported
    // Deduct correctly: 20 - 0.5 = 19.5
  });

  test('should handle very large balance', async () => {
    // Balance: 999.99 days
    // Request: 1 day
    // Should work correctly
    // Deduct: 999.99 - 1 = 998.99
  });

  test('should handle very large number of employees', async () => {
    // Batch sync: 100k+ employees
    // Should complete without timeout
    // Should not cause memory issues
  });

  test('should handle requests with dates far in future', async () => {
    // Request dates: 1 year from now
    // Should be valid as long as balance exists
  });
});
```

### 7.4 Multi-Location Edge Cases
```typescript
describe('Edge Cases: Multi-Location Scenarios', () => {
  test('should handle employee with many locations (10+)', async () => {
    // Employee with 15 locations across different countries
    // GET /api/balances/{employeeId}
    // 
    // Should return all 15 locations without timeout
    // Each location has independent balances
    // Response should not exceed reasonable size (< 100KB)
  });

  test('should prevent location-based balance pooling', async () => {
    // Employee John:
    // - NYC: 0 days vacation
    // - LA: 20 days vacation
    // 
    // Request NYC: 5 days
    // Should reject: Insufficient balance (NYC only has 0)
    // Should NOT use LA balance (locations are independent)
  });

  test('should handle cross-location concurrent race conditions', async () => {
    // Employee at NYC and LA
    // NYC Request: Deduct 5 (version 5 → 6)
    // LA Request: Deduct 3 (version 5 → 6)
    // 
    // Both versions track independently:
    // - NYC version: 5 → 6 ✓
    // - LA version: 5 → 6 ✓
    // 
    // No interference between locations
    // Both succeed (different rows in DB)
  });

  test('should handle manager authorization with location mismatch gracefully', async () => {
    // Employee John (NYC and LA)
    // NYC Manager (Sarah) tries to approve LA request
    // 
    // System should:
    // 1. Clear error message
    // 2. Include: request location, manager location
    // 3. Suggest: "Contact LA Manager (Mike)"
    // 4. Log for audit
    // 5. Return 403 UnauthorizedError
  });

  test('should handle batch sync with location-specific constraints', async () => {
    // Batch sync for 50k employees across 10 locations
    // LA location has stricter policy: balances capped at 30 days
    // 
    // Batch update:
    // - NYC employee: 35 days → accepted (no cap)
    // - LA employee: 35 days → capped to 30 (HCM policy)
    // 
    // System should respect HCM policy per location
  });

  test('should handle employee with no locations (edge case)', async () => {
    // Employee created but not assigned to any location
    // Request submission should fail: NoLocationError
    // GET balance should return empty locations array
    // Audit: Log as data integrity issue
  });

  test('should handle single employee transitioning locations mid-request', async () => {
    // Day 1: Request submitted from NYC (HCM confirms NYC location)
    // Day 2: Employee transferred to LA (HCM updated)
    // 
    // Request still in "processing" in NYC
    // System uses location from REQUEST, not current HCM location
    // Submit to HCM with NYC location (original request location)
  });
});
```

---

## 8. Test Coverage Targets

### 8.1 Coverage by Service
```
BalanceService:     95% (5 methods, critical path)
RequestService:     95% (lifecycle management)
HCMSyncService:     90% (depends on mock HCM reliability)
DivergenceService:  95% (important logic)
Controllers:        85% (input validation, routing)
Utils/Helpers:      70% (less critical)
```

### 8.2 Line Coverage Goals
- **Overall**: 85% minimum
- **Service Logic**: 95% minimum
- **Integration Paths**: 90% minimum
- **Error Paths**: 80% minimum

### 8.3 Branch Coverage
- All if/else paths covered
- All error conditions tested
- Happy path + at least one alternate path per decision

---

## 9. Mock HCM Server Specification

### 9.1 API Endpoints
```typescript
// Real-Time API
GET /api/balances/{employeeId}/{locationId}
  Response: {balance: number, hcm_version: number, lastUpdatedAt: ISO8601}
  
POST /api/submissions
  Body: {employeeId, locationId, balanceType, daysRequested}
  Response: {submissionId: string, status: "received"}
  
GET /api/submissions/{submissionId}
  Response: {status: "processing" | "approved" | "rejected", details: {...}}
  
// Batch API
GET /api/balances/batch
  Response: [{employeeId, locationId, balanceType, balance, hcm_version}, ...]
  
Health Check
GET /health
  Response: {status: "ok"}
```

### 9.2 Configuration & State Management
```typescript
// Configurable behaviors
server.forceError(errorCode, message)
server.forceDelay(ms)
server.setDeterministicValues({employeeId, values})
server.forceApprove(submissionId)
server.forceReject(submissionId)
server.reset()  // Clear all state

// State tracking
server.getSubmissionHistory()  // All submissions received
server.getBalanceUpdates()     // All balance changes
server.getErrors()             // All errors encountered
```

### 9.3 Simulation Features
```typescript
// Default behavior
- Submissions: Always return "received"
- Polling: Random delay before returning "approved" (5-30 seconds)
- Balances: Return configured values
- Version: Increment on each update

// Failure simulation
- 503 errors for transient failures
- 404 for non-existent employee
- Timeout (no response)
- Slow responses (3+ seconds)

// Realistic scenarios
- Balance updates between submission and polling (race conditions)
- Work anniversary bonus (auto-increase)
- Policy change (auto-decrease)
```

### 9.4 Multi-Location Mock Data
```typescript
// Mock HCM should support multi-location test data:

// Single location employee
setDeterministicValues({
  employee: "john-single",
  locations: ["NYC"],
  balances: {
    NYC: {
      vacation: 20,
      sick: 10,
      personal: 5,
      hcm_version: 1
    }
  }
})

// Multi-location employee
setDeterministicValues({
  employee: "john-multi",
  locations: ["NYC", "LA", "Chicago"],
  balances: {
    NYC: {
      vacation: 20, sick: 10, personal: 5, hcm_version: 1
    },
    LA: {
      vacation: 15, sick: 8, personal: 3, hcm_version: 2
    },
    Chicago: {
      vacation: 18, sick: 9, personal: 4, hcm_version: 1
    }
  }
})

// Simulate location-specific divergence
forceBalanceUpdate("john-multi", "NYC", {
  vacation: 25,  // Work anniversary
  hcm_version: 2
})

// Simulate location-specific approval
forceApprove("sub-123", "NYC", "approved")
forceApprove("sub-124", "LA", "rejected")

// Simulate partial batch sync failure
forceBatchError("LA", 503)  // LA batch times out, others succeed

// Get location-specific history
getSubmissionHistory("john-multi", "NYC")  // Only NYC submissions
getBalanceUpdates("john-multi", "LA")      // Only LA balance changes
```

---

## 10. Test Execution Plan

### 10.1 Test Organization
```
tests/
  ├── unit/
  │   ├── balance.service.spec.ts
  │   ├── request.service.spec.ts
  │   ├── hcm-sync.service.spec.ts
  │   └── divergence.service.spec.ts
  ├── integration/
  │   ├── happy-path.spec.ts
  │   ├── divergence.spec.ts
  │   ├── stuck-requests.spec.ts
  │   ├── race-conditions.spec.ts
  │   └── multi-location.spec.ts       (NEW: Multi-location workflows)
  ├── edge-cases/
  │   ├── errors.spec.ts
  │   ├── boundaries.spec.ts
  │   └── multi-location-edge-cases.spec.ts (NEW: Location-specific edge cases)
  ├── fixtures/
  │   ├── mock-hcm.ts (~400 lines)
  │   ├── test-data.ts
  │   ├── multi-location-data.ts      (NEW: Multi-location test data)
  │   └── setup.ts
  └── jest.config.ts
```

### 10.2 Running Tests
```bash
# All tests
npm test

# Unit tests only
npm test -- --testPathPattern=unit

# Integration tests only
npm test -- --testPathPattern=integration

# Edge case tests only
npm test -- --testPathPattern=edge-cases

# With coverage
npm test -- --coverage

# Watch mode
npm test -- --watch
```

### 10.3 Coverage Report
```bash
npm test -- --coverage --coverageReporters=text --coverageReporters=html

# View: coverage/index.html
# Verify: 85% overall, 95% service logic
```

---

## 11. Test Dependencies & Mocking

### 11.1 Mocking Strategy
```typescript
// Mock HCM: Real server (~400 lines), not Jest mocks
// Mock Redis: Jest mock (in-memory store)
// Mock Database: SQLite :memory:
// Mock Clock: Jest fake timers for nightly jobs
// Mock Logger: Jest mock for audit trail verification
```

### 11.2 Test Utilities
```typescript
// Setup
setupDatabase()        // Create in-memory SQLite
startMockHCM()        // Start mock server on random port
seedTestData()        // Insert test employees, balances

// Execution
createRequest()       // Helper to create test request
approveRequest()      // Helper to approve
submitToHCM()        // Helper to trigger submission
pollUntilTerminal()  // Helper to wait for decision

// Verification
getBalance()         // Query balance from DB
getAuditLog()        // Query audit trail
countRequests()      // Count by status
```

---

**End of Test Suite Specification**
