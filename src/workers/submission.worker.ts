/**
 * HCM Submission Worker
 * Picks up requests in "processing" status that haven't been submitted to HCM yet,
 * and submits them. Runs on an interval.
 */

import Database from 'better-sqlite3';
import { RequestService } from '../services/request.service';
import { HCMSyncService } from '../services/hcm-sync.service';

export class HCMSubmissionWorker {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private db: Database.Database,
    private requestService: RequestService,
    private hcmSyncService: HCMSyncService,
    private intervalMs: number = 5000
  ) {}

  start(): void {
    if (this.intervalId) return;

    console.log(`[SubmissionWorker] Started (interval: ${this.intervalMs}ms)`);
    this.intervalId = setInterval(() => this.tick(), this.intervalMs);
    // Run immediately on start
    this.tick();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[SubmissionWorker] Stopped');
    }
  }

  isRunning(): boolean {
    return this.intervalId !== null;
  }

  async tick(): Promise<{ submitted: number; failed: number }> {
    if (this.running) return { submitted: 0, failed: 0 };
    this.running = true;

    let submitted = 0;
    let failed = 0;

    try {
      // Find processing requests without HCM submission
      const pending = this.db.prepare(
        `SELECT id, employee_id, location_id, balance_type, days_requested
         FROM requests
         WHERE status = 'processing' AND hcm_submission_id IS NULL
         ORDER BY created_at ASC
         LIMIT 10`
      ).all() as any[];

      for (const req of pending) {
        try {
          const submissionId = await this.hcmSyncService.submitRequest(
            req.id,
            req.employee_id,
            req.location_id,
            req.balance_type,
            req.days_requested
          );

          await this.requestService.recordHCMSubmission(req.id, submissionId);
          submitted++;
          console.log(`[SubmissionWorker] Submitted ${req.id} → HCM ${submissionId}`);
        } catch (error) {
          failed++;
          console.error(`[SubmissionWorker] Failed to submit ${req.id}:`, error);
        }
      }
    } catch (error) {
      console.error('[SubmissionWorker] Tick error:', error);
    } finally {
      this.running = false;
    }

    return { submitted, failed };
  }
}
