/**
 * Batch Sync Scheduler
 * Runs daily at 2 AM to sync all balances from HCM.
 * Also provides stuck request recovery (requests in "processing" for 24+ hours).
 */

import Database from 'better-sqlite3';
import { HCMSyncService } from '../services/hcm-sync.service';
import { RequestService } from '../services/request.service';
import { RedisCacheService } from '../services/redis-cache.service';

export class BatchSyncScheduler {
  private syncIntervalId: ReturnType<typeof setInterval> | null = null;
  private recoveryIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: Database.Database,
    private hcmSyncService: HCMSyncService,
    private requestService: RequestService,
    private syncIntervalMs: number = 60 * 60 * 1000, // Default: 1 hour
    private recoveryIntervalMs: number = 6 * 60 * 60 * 1000, // Default: 6 hours
    private stuckThresholdMs: number = 24 * 60 * 60 * 1000, // Default: 24 hours
    private cache?: RedisCacheService
  ) {}

  start(): void {
    if (this.syncIntervalId) return;

    console.log('[BatchSync] Scheduler started');

    // Batch sync on interval
    this.syncIntervalId = setInterval(() => this.runBatchSync(), this.syncIntervalMs);

    // Stuck request recovery on interval
    this.recoveryIntervalId = setInterval(() => this.recoverStuckRequests(), this.recoveryIntervalMs);
  }

  stop(): void {
    if (this.syncIntervalId) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    if (this.recoveryIntervalId) {
      clearInterval(this.recoveryIntervalId);
      this.recoveryIntervalId = null;
    }
    console.log('[BatchSync] Scheduler stopped');
  }

  isRunning(): boolean {
    return this.syncIntervalId !== null;
  }

  /**
   * Run a full batch sync from HCM
   */
  async runBatchSync(): Promise<{ success: boolean; updatedCount: number; failedLocations: string[] }> {
    console.log('[BatchSync] Starting batch sync...');
    const startTime = Date.now();

    try {
      const result = await this.hcmSyncService.batchSync();
      const duration = Date.now() - startTime;

      console.log(
        `[BatchSync] Completed in ${duration}ms: ${result.updatedCount} updated, ` +
        `${result.failedLocations.length} failed locations`
      );

      this.createAuditLog('batch_sync_completed', {
        success: result.success,
        updatedCount: result.updatedCount,
        failedLocations: result.failedLocations,
        durationMs: duration
      });

      return result;
    } catch (error) {
      console.error('[BatchSync] Failed:', error);
      this.createAuditLog('batch_sync_failed', {
        error: String(error),
        durationMs: Date.now() - startTime
      });
      return { success: false, updatedCount: 0, failedLocations: ['all'] };
    }
  }

  /**
   * Recover stuck requests (in "processing" for longer than threshold)
   * Makes a final HCM check, then rejects if still unresolved
   */
  async recoverStuckRequests(): Promise<{ recovered: number; rejected: number }> {
    console.log('[BatchSync] Checking for stuck requests...');
    let recovered = 0;
    let rejected = 0;

    try {
      const cutoffTime = new Date(Date.now() - this.stuckThresholdMs).toISOString();

      const stuckRequests = this.db.prepare(
        `SELECT id, hcm_submission_id, employee_id, location_id, balance_type, days_requested
         FROM requests
         WHERE status = 'processing'
           AND submitted_to_hcm_at IS NOT NULL
           AND submitted_to_hcm_at < ?
         ORDER BY submitted_to_hcm_at ASC`
      ).all(cutoffTime) as any[];

      console.log(`[BatchSync] Found ${stuckRequests.length} stuck requests`);

      for (const req of stuckRequests) {
        try {
          // Final check with HCM
          const status = await this.hcmSyncService.pollStatus(req.hcm_submission_id);

          if (status === 'approved') {
            const balance = await this.getBalance(req.employee_id, req.location_id, req.balance_type);
            if (balance) {
              this.deductBalanceDirectly(req.employee_id, req.location_id, req.balance_type, req.days_requested);
            }
            await this.requestService.markHCMApproved(req.id);
            recovered++;
            console.log(`[BatchSync] Recovered ${req.id}: approved`);
          } else if (status === 'rejected') {
            await this.requestService.markHCMRejected(req.id, 'Rejected by HCM (recovered from stuck)');
            recovered++;
            console.log(`[BatchSync] Recovered ${req.id}: rejected`);
          } else {
            // Still processing after 24+ hours — reject as stuck
            await this.requestService.markHCMRejected(
              req.id,
              `Request stuck in processing for over ${Math.round(this.stuckThresholdMs / 3600000)} hours. Auto-rejected.`
            );
            rejected++;
            console.log(`[BatchSync] Auto-rejected stuck request ${req.id}`);
          }

          this.createAuditLog('stuck_request_recovery', {
            requestId: req.id,
            hcmSubmissionId: req.hcm_submission_id,
            hcmStatus: status,
            action: status === 'processing' ? 'auto_rejected' : 'recovered'
          });
        } catch (error) {
          console.error(`[BatchSync] Error recovering ${req.id}:`, error);
        }
      }
    } catch (error) {
      console.error('[BatchSync] Recovery failed:', error);
    }

    return { recovered, rejected };
  }

  private getBalance(employeeId: string, locationId: string, balanceType: string): any {
    return this.db.prepare(
      `SELECT id, current_balance, hcm_version FROM balances
       WHERE employee_id = ? AND location_id = ? AND balance_type = ?`
    ).get(employeeId, locationId, balanceType);
  }

  private deductBalanceDirectly(employeeId: string, locationId: string, balanceType: string, amount: number): void {
    this.db.prepare(
      `UPDATE balances SET current_balance = current_balance - ?, hcm_version = hcm_version + 1, updated_at = ?
       WHERE employee_id = ? AND location_id = ? AND balance_type = ?`
    ).run(amount, new Date().toISOString(), employeeId, locationId, balanceType);

    // Invalidate cache
    if (this.cache) {
      this.cache.del(`balance:${employeeId}:${locationId}:${balanceType}`);
      this.cache.del(`balances:employee:${employeeId}`);
    }
  }

  private createAuditLog(eventType: string, details: any): void {
    const crypto = require('crypto');
    this.db.prepare(
      `INSERT INTO audit_logs (id, entity_type, entity_id, event_type, actor, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(crypto.randomUUID(), 'system', 'scheduler', eventType, 'system', JSON.stringify(details), new Date().toISOString());
  }
}
