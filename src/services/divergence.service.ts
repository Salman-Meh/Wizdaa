/**
 * DivergenceService
 * Detects and handles balance divergence between local cache and HCM
 */

import Database from 'better-sqlite3';
import { Divergence } from '../models/types';

export class DivergenceService {
  constructor(private db: Database.Database) {}

  /**
   * Detect divergence between submitted balance and current balance
   */
  detectDivergence(
    submittedBalance: number,
    currentBalance: number,
    daysRequested: number
  ): Divergence {
    if (submittedBalance === currentBalance) {
      return { detected: false };
    }

    const type = currentBalance > submittedBalance ? 'increase' : 'decrease';
    const isValid = currentBalance >= daysRequested;

    return {
      detected: true,
      type,
      previousBalance: submittedBalance,
      currentBalance,
      isValid,
      reason: this.getDivergenceReason(type, submittedBalance, currentBalance, daysRequested)
    };
  }

  /**
   * Generate divergence reason for employee notification
   */
  private getDivergenceReason(
    type: 'increase' | 'decrease',
    previousBalance: number,
    currentBalance: number,
    daysRequested: number
  ): string {
    if (type === 'increase') {
      const diff = currentBalance - previousBalance;
      return `Your balance increased from ${previousBalance} to ${currentBalance} days (+${diff}). Do you want to proceed with your request?`;
    } else {
      const diff = previousBalance - currentBalance;
      return `Your balance decreased from ${previousBalance} to ${currentBalance} days (-${diff}). You requested ${daysRequested} days. ${
        currentBalance >= daysRequested
          ? 'Do you want to proceed?'
          : 'Insufficient balance. Cancelling request.'
      }`;
    }
  }

  /**
   * Auto-reconcile divergence
   * Returns true if divergence can be auto-handled, false if needs employee confirmation
   */
  canAutoReconcile(divergence: Divergence): boolean {
    if (!divergence.detected) {
      return true;
    }

    // Auto-approve balance increases (employee benefit)
    if (divergence.type === 'increase') {
      return true;
    }

    // Auto-reject balance decreases that make request invalid
    if (divergence.type === 'decrease' && !divergence.isValid) {
      return true;
    }

    // Balance decreases but request still valid - need employee confirmation
    return false;
  }

  /**
   * Log divergence for audit trail
   */
  logDivergence(
    requestId: string,
    divergence: Divergence,
    actor: string = 'system'
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO audit_logs (id, entity_type, entity_id, event_type, actor, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    const crypto = require('crypto');
    const id = crypto.randomUUID ? crypto.randomUUID() : require('uuid').v4();

    stmt.run(
      id,
      'request',
      requestId,
      'divergence_detected',
      actor,
      JSON.stringify({
        type: divergence.type,
        previousBalance: divergence.previousBalance,
        currentBalance: divergence.currentBalance,
        isValid: divergence.isValid,
        reason: divergence.reason
      }),
      new Date().toISOString()
    );
  }

  /**
   * Get divergence statistics for monitoring
   */
  getDivergenceStats(
    hoursBack: number = 24
  ): { total: number; increases: number; decreases: number; autoResolved: number } {
    const cutoffTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

    const stmt = this.db.prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN details LIKE '%"increase"%' THEN 1 ELSE 0 END) as increases,
        SUM(CASE WHEN details LIKE '%"decrease"%' THEN 1 ELSE 0 END) as decreases
       FROM audit_logs
       WHERE event_type = 'divergence_detected' AND created_at > ?`
    );

    const row = stmt.get(cutoffTime) as any;

    // Note: This is a simplified version. In production, you'd parse the JSON properly
    return {
      total: row?.total || 0,
      increases: row?.increases || 0,
      decreases: row?.decreases || 0,
      autoResolved: 0 // Would need more sophisticated tracking
    };
  }
}
