/**
 * RequestService
 * Manages request lifecycle:
 * - Submit request
 * - Manager approval (with location validation and divergence detection)
 * - Employee confirmation (after divergence)
 * - Track request status
 */

import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import { Request, RequestStatus, BalanceType } from '../models/types';
import { BalanceService } from './balance.service';

export class RequestService {
  constructor(
    private db: Database.Database,
    private balanceService: BalanceService
  ) {}

  /**
   * Submit a time-off request
   */
  async submitRequest(input: {
    employeeId: string;
    locationId: string;
    balanceType: BalanceType;
    daysRequested: number;
  }): Promise<Request> {
    // Validate balance exists and is sufficient
    const balance = await this.balanceService.getBalance(
      input.employeeId,
      input.locationId,
      input.balanceType
    );

    if (balance.currentBalance < input.daysRequested) {
      throw new Error(
        `Insufficient balance: ${balance.currentBalance} < ${input.daysRequested} requested`
      );
    }

    // Create request
    const id = uuidv4();
    const now = new Date();

    const stmt = this.db.prepare(
      `INSERT INTO requests (
        id, employee_id, location_id, balance_type, days_requested,
        requested_balance_at_submission, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    stmt.run(
      id,
      input.employeeId,
      input.locationId,
      input.balanceType,
      input.daysRequested,
      balance.currentBalance, // Snapshot balance at submission
      'pending_manager_approval',
      now.toISOString(),
      now.toISOString()
    );

    // Create audit log
    this.createAuditLog('request', id, 'request_submitted', input.employeeId, {
      employeeId: input.employeeId,
      locationId: input.locationId,
      balanceType: input.balanceType,
      daysRequested: input.daysRequested,
      balanceAtSubmission: balance.currentBalance
    });

    return this.getRequestStatus(id);
  }

  /**
   * Manager approves request
   * Validates location and detects divergence
   */
  async approveRequest(
    requestId: string,
    managerId: string,
    managerLocationId: string
  ): Promise<Request> {
    // Fetch request
    const request = await this.getRequestStatus(requestId);

    if (!request) {
      throw new Error(`Request ${requestId} not found`);
    }

    // Validate manager is from same location as request
    if (request.locationId !== managerLocationId) {
      throw new Error(
        `Unauthorized: Manager from ${managerLocationId} cannot approve requests for ${request.locationId}`
      );
    }

    // Validate request is in correct state
    if (request.status !== 'pending_manager_approval') {
      throw new Error(`Cannot approve request in status: ${request.status}`);
    }

    // Fetch current balance from local storage
    const balance = await this.balanceService.getBalance(
      request.employeeId,
      request.locationId,
      request.balanceType
    );

    // Check for divergence
    const divergence = await this.balanceService.detectDivergence(
      request.requestedBalanceAtSubmission,
      balance.currentBalance,
      request.daysRequested
    );

    // Handle divergence
    if (divergence.detected) {
      if (divergence.type === 'increase') {
        // Balance increased (employee benefit) - auto-approve
        return this.transitionToProcessing(requestId, managerId, managerLocationId, divergence);
      } else if (divergence.type === 'decrease') {
        if (!divergence.isValid) {
          // Balance decrease makes request invalid - auto-reject
          return this.rejectRequest(requestId, managerId, 'Insufficient balance after HCM update', divergence);
        } else {
          // Balance decreased but still valid - pause and notify employee
          return this.pauseForDivergenceConfirmation(requestId, managerId, divergence);
        }
      }
    }

    // No divergence - proceed to processing
    return this.transitionToProcessing(requestId, managerId, managerLocationId);
  }

  /**
   * Employee confirms after divergence detection
   */
  async confirmRequest(
    requestId: string,
    employeeId: string,
    action: 'proceed' | 'cancel'
  ): Promise<Request> {
    // Fetch request
    const request = await this.getRequestStatus(requestId);

    if (!request) {
      throw new Error(`Request ${requestId} not found`);
    }

    // Validate request is in correct state
    if (request.status !== 'pending_employee_confirmation') {
      throw new Error(
        `Cannot confirm request in status: ${request.status}. Expected: pending_employee_confirmation`
      );
    }

    // Validate employee is the request owner
    if (request.employeeId !== employeeId) {
      throw new Error('Unauthorized: Can only confirm own requests');
    }

    if (action === 'proceed') {
      // Transition to processing and queue HCM submission
      return this.transitionToProcessing(
        requestId,
        employeeId,
        request.locationId
      );
    } else if (action === 'cancel') {
      // Reject the request
      return this.rejectRequest(requestId, employeeId, 'Cancelled by employee due to balance change');
    } else {
      throw new Error(`Invalid action: ${action}`);
    }
  }

  /**
   * Get request status
   */
  async getRequestStatus(requestId: string): Promise<Request> {
    const stmt = this.db.prepare(
      `SELECT
        id, employee_id, location_id, balance_type, days_requested,
        requested_balance_at_submission, status, manager_id, manager_location_id,
        manager_action_at, manager_reason, hcm_submission_id, submitted_to_hcm_at,
        hcm_approved_at, divergence_detected_at, divergence_reason, created_at, updated_at
       FROM requests WHERE id = ?`
    );

    const row = stmt.get(requestId) as any;

    if (!row) {
      throw new Error(`Request ${requestId} not found`);
    }

    return {
      id: row.id,
      employeeId: row.employee_id,
      locationId: row.location_id,
      balanceType: row.balance_type,
      daysRequested: row.days_requested,
      requestedBalanceAtSubmission: row.requested_balance_at_submission,
      status: row.status as RequestStatus,
      managerId: row.manager_id,
      managerLocationId: row.manager_location_id,
      managerActionAt: row.manager_action_at ? new Date(row.manager_action_at) : undefined,
      managerReason: row.manager_reason,
      hcmSubmissionId: row.hcm_submission_id,
      submittedToHcmAt: row.submitted_to_hcm_at ? new Date(row.submitted_to_hcm_at) : undefined,
      hcmApprovedAt: row.hcm_approved_at ? new Date(row.hcm_approved_at) : undefined,
      divergenceDetectedAt: row.divergence_detected_at
        ? new Date(row.divergence_detected_at)
        : undefined,
      divergenceReason: row.divergence_reason,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }

  /**
   * Get all requests in processing status (for polling)
   */
  async getRequestsInProcessing(): Promise<Request[]> {
    const stmt = this.db.prepare(
      `SELECT
        id, employee_id, location_id, balance_type, days_requested,
        requested_balance_at_submission, status, manager_id, manager_location_id,
        manager_action_at, manager_reason, hcm_submission_id, submitted_to_hcm_at,
        hcm_approved_at, divergence_detected_at, divergence_reason, created_at, updated_at
       FROM requests WHERE status = 'processing'
       ORDER BY submitted_to_hcm_at ASC`
    );

    const rows = stmt.all() as any[];

    return rows.map((row) => ({
      id: row.id,
      employeeId: row.employee_id,
      locationId: row.location_id,
      balanceType: row.balance_type,
      daysRequested: row.days_requested,
      requestedBalanceAtSubmission: row.requested_balance_at_submission,
      status: row.status as RequestStatus,
      managerId: row.manager_id,
      managerLocationId: row.manager_location_id,
      managerActionAt: row.manager_action_at ? new Date(row.manager_action_at) : undefined,
      managerReason: row.manager_reason,
      hcmSubmissionId: row.hcm_submission_id,
      submittedToHcmAt: row.submitted_to_hcm_at ? new Date(row.submitted_to_hcm_at) : undefined,
      hcmApprovedAt: row.hcm_approved_at ? new Date(row.hcm_approved_at) : undefined,
      divergenceDetectedAt: row.divergence_detected_at
        ? new Date(row.divergence_detected_at)
        : undefined,
      divergenceReason: row.divergence_reason,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    }));
  }

  /**
   * Mark request as approved by HCM
   */
  async markHCMApproved(requestId: string): Promise<Request> {
    const now = new Date();
    const stmt = this.db.prepare(
      `UPDATE requests SET status = 'approved', hcm_approved_at = ?, updated_at = ? WHERE id = ?`
    );

    stmt.run(now.toISOString(), now.toISOString(), requestId);

    this.createAuditLog('request', requestId, 'hcm_approved', 'system', {
      approvedAt: now.toISOString()
    });

    return this.getRequestStatus(requestId);
  }

  /**
   * Mark request as rejected by HCM
   */
  async markHCMRejected(requestId: string, reason?: string): Promise<Request> {
    const now = new Date();
    const stmt = this.db.prepare(
      `UPDATE requests SET status = 'rejected', manager_reason = ?, updated_at = ? WHERE id = ?`
    );

    stmt.run(reason || 'Rejected by HCM', now.toISOString(), requestId);

    this.createAuditLog('request', requestId, 'hcm_rejected', 'system', {
      reason: reason || 'Rejected by HCM',
      rejectedAt: now.toISOString()
    });

    return this.getRequestStatus(requestId);
  }

  /**
   * Record HCM submission
   */
  async recordHCMSubmission(requestId: string, submissionId: string): Promise<Request> {
    const now = new Date();
    const stmt = this.db.prepare(
      `UPDATE requests SET
        hcm_submission_id = ?, submitted_to_hcm_at = ?, updated_at = ?
       WHERE id = ?`
    );

    stmt.run(submissionId, now.toISOString(), now.toISOString(), requestId);

    this.createAuditLog('request', requestId, 'submitted_to_hcm', 'system', {
      hcmSubmissionId: submissionId,
      submittedAt: now.toISOString()
    });

    return this.getRequestStatus(requestId);
  }

  /**
   * Private helper: Transition to processing
   */
  private async transitionToProcessing(
    requestId: string,
    actor: string,
    managerLocationId: string,
    divergence?: any
  ): Promise<Request> {
    const now = new Date();

    if (divergence && divergence.detected) {
      // With divergence - set divergence fields
      const reason = `Balance changed from ${divergence.previousBalance} to ${divergence.currentBalance}.`;
      const stmt = this.db.prepare(
        `UPDATE requests SET
          status = 'processing',
          divergence_detected_at = ?,
          divergence_reason = ?,
          manager_id = ?,
          manager_location_id = ?,
          manager_action_at = ?,
          updated_at = ?
         WHERE id = ?`
      );

      stmt.run(
        now.toISOString(),
        reason,
        actor,
        managerLocationId,
        now.toISOString(),
        now.toISOString(),
        requestId
      );

      this.createAuditLog('request', requestId, 'approved_with_divergence', actor, {
        managerId: actor,
        managerLocationId,
        divergence: {
          type: divergence.type,
          previousBalance: divergence.previousBalance,
          currentBalance: divergence.currentBalance
        },
        approvedAt: now.toISOString()
      });
    } else {
      // No divergence
      const stmt = this.db.prepare(
        `UPDATE requests SET
          status = 'processing',
          manager_id = ?,
          manager_location_id = ?,
          manager_action_at = ?,
          updated_at = ?
         WHERE id = ?`
      );

      stmt.run(actor, managerLocationId, now.toISOString(), now.toISOString(), requestId);

      this.createAuditLog('request', requestId, 'approved_by_manager', actor, {
        managerId: actor,
        managerLocationId,
        approvedAt: now.toISOString()
      });
    }

    return this.getRequestStatus(requestId);
  }

  /**
   * Private helper: Pause for employee confirmation due to divergence
   */
  private async pauseForDivergenceConfirmation(
    requestId: string,
    managerId: string,
    divergence: any
  ): Promise<Request> {
    const now = new Date();
    const stmt = this.db.prepare(
      `UPDATE requests SET
        status = 'pending_employee_confirmation',
        divergence_detected_at = ?,
        divergence_reason = ?,
        manager_id = ?,
        manager_action_at = ?,
        updated_at = ?
       WHERE id = ?`
    );

    const reason = `Balance changed from ${divergence.previousBalance} to ${divergence.currentBalance}. Request still requires ${divergence.currentBalance >= 0 ? 'confirmation' : 'cancellation'}.`;

    stmt.run(
      now.toISOString(),
      reason,
      managerId,
      now.toISOString(),
      now.toISOString(),
      requestId
    );

    this.createAuditLog('request', requestId, 'divergence_detected', 'system', {
      previousBalance: divergence.previousBalance,
      currentBalance: divergence.currentBalance,
      type: divergence.type,
      detectedAt: now.toISOString()
    });

    return this.getRequestStatus(requestId);
  }

  /**
   * Private helper: Reject request
   */
  private async rejectRequest(requestId: string, actor: string, reason: string, divergence?: any): Promise<Request> {
    const now = new Date();

    if (divergence && divergence.detected) {
      // Reject with divergence tracking
      const divergenceReason = `${reason} (Balance: ${divergence.previousBalance} → ${divergence.currentBalance})`;
      const stmt = this.db.prepare(
        `UPDATE requests SET
          status = 'rejected',
          divergence_detected_at = ?,
          divergence_reason = ?,
          manager_id = ?,
          manager_reason = ?,
          manager_action_at = ?,
          updated_at = ?
         WHERE id = ?`
      );

      stmt.run(
        now.toISOString(),
        divergenceReason,
        actor,
        reason,
        now.toISOString(),
        now.toISOString(),
        requestId
      );

      this.createAuditLog('request', requestId, 'rejected_by_divergence', actor, {
        reason,
        divergence: {
          type: divergence.type,
          previousBalance: divergence.previousBalance,
          currentBalance: divergence.currentBalance
        },
        rejectedAt: now.toISOString()
      });
    } else {
      // Reject without divergence
      const stmt = this.db.prepare(
        `UPDATE requests SET
          status = 'rejected',
          manager_id = ?,
          manager_reason = ?,
          manager_action_at = ?,
          updated_at = ?
         WHERE id = ?`
      );

      stmt.run(actor, reason, now.toISOString(), now.toISOString(), requestId);

      this.createAuditLog('request', requestId, 'rejected', actor, {
        reason,
        rejectedAt: now.toISOString()
      });
    }

    return this.getRequestStatus(requestId);
  }

  /**
   * Create audit log
   */
  private createAuditLog(
    entityType: string,
    entityId: string,
    eventType: string,
    actor: string | null,
    details: any
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO audit_logs (id, entity_type, entity_id, event_type, actor, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    stmt.run(
      uuidv4(),
      entityType,
      entityId,
      eventType,
      actor,
      JSON.stringify(details),
      new Date().toISOString()
    );
  }
}
