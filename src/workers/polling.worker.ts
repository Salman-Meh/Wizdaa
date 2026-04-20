/**
 * HCM Polling Worker
 * Polls HCM for status updates on submitted requests.
 * Requests in "processing" with an hcm_submission_id are polled until terminal state.
 * Gives up after 1 hour (configurable).
 */

import Database from 'better-sqlite3';
import { RequestService } from '../services/request.service';
import { HCMSyncService } from '../services/hcm-sync.service';
import { BalanceService } from '../services/balance.service';

export class HCMPollingWorker {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private db: Database.Database,
    private requestService: RequestService,
    private hcmSyncService: HCMSyncService,
    private balanceService: BalanceService,
    private intervalMs: number = 5000,
    private maxPollingMs: number = 60 * 60 * 1000 // 1 hour
  ) {}

  start(): void {
    if (this.intervalId) return;

    console.log(`[PollingWorker] Started (interval: ${this.intervalMs}ms, max: ${this.maxPollingMs}ms)`);
    this.intervalId = setInterval(() => this.tick(), this.intervalMs);
    this.tick();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[PollingWorker] Stopped');
    }
  }

  isRunning(): boolean {
    return this.intervalId !== null;
  }

  async tick(): Promise<{ approved: number; rejected: number; stillProcessing: number; timedOut: number }> {
    if (this.running) return { approved: 0, rejected: 0, stillProcessing: 0, timedOut: 0 };
    this.running = true;

    let approved = 0;
    let rejected = 0;
    let stillProcessing = 0;
    let timedOut = 0;

    try {
      // Find requests submitted to HCM that are still processing
      const pending = this.db.prepare(
        `SELECT id, employee_id, location_id, balance_type, days_requested,
                hcm_submission_id, submitted_to_hcm_at
         FROM requests
         WHERE status = 'processing' AND hcm_submission_id IS NOT NULL
         ORDER BY submitted_to_hcm_at ASC
         LIMIT 50`
      ).all() as any[];

      for (const req of pending) {
        try {
          // Check if polling has timed out
          const submittedAt = new Date(req.submitted_to_hcm_at).getTime();
          if (Date.now() - submittedAt > this.maxPollingMs) {
            console.warn(`[PollingWorker] Request ${req.id} timed out after ${this.maxPollingMs}ms`);
            this.createAuditLog(req.id, 'polling_timeout', {
              submissionId: req.hcm_submission_id,
              submittedAt: req.submitted_to_hcm_at,
              timedOutAt: new Date().toISOString()
            });
            timedOut++;
            continue;
          }

          const status = await this.hcmSyncService.pollStatus(req.hcm_submission_id);

          if (status === 'approved') {
            // Deduct balance and mark approved
            const balance = await this.balanceService.getBalance(
              req.employee_id, req.location_id, req.balance_type
            );
            await this.balanceService.deductBalance(
              req.employee_id, req.location_id, req.balance_type,
              req.days_requested, balance.hcmVersion
            );
            await this.requestService.markHCMApproved(req.id);
            approved++;
            console.log(`[PollingWorker] ${req.id} approved by HCM`);
          } else if (status === 'rejected') {
            await this.requestService.markHCMRejected(req.id, 'Rejected by HCM');
            rejected++;
            console.log(`[PollingWorker] ${req.id} rejected by HCM`);
          } else {
            stillProcessing++;
          }
        } catch (error) {
          console.error(`[PollingWorker] Error polling ${req.id}:`, error);
        }
      }
    } catch (error) {
      console.error('[PollingWorker] Tick error:', error);
    } finally {
      this.running = false;
    }

    return { approved, rejected, stillProcessing, timedOut };
  }

  private createAuditLog(requestId: string, eventType: string, details: any): void {
    const crypto = require('crypto');
    const id = crypto.randomUUID();

    this.db.prepare(
      `INSERT INTO audit_logs (id, entity_type, entity_id, event_type, actor, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, 'request', requestId, eventType, 'system', JSON.stringify(details), new Date().toISOString());
  }
}
