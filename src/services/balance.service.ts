/**
 * BalanceService
 * Manages time-off balance operations:
 * - Get balance (local + HCM verification)
 * - Deduct balance (with optimistic locking)
 * - Batch updates (for daily sync)
 * - Divergence detection
 */

import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import { Balance, BalanceType, Divergence } from '../models/types';
import { RedisCacheService } from './redis-cache.service';

export class BalanceService {
  constructor(
    private db: Database.Database,
    private cache?: RedisCacheService
  ) {}

  /**
   * Get balance for employee at location
   * Returns existing balance or creates new one
   */
  async getBalance(employeeId: string, locationId: string, balanceType: BalanceType): Promise<Balance> {
    // Check cache first
    const cacheKey = `balance:${employeeId}:${locationId}:${balanceType}`;
    if (this.cache) {
      const cached = await this.cache.get<Balance>(cacheKey);
      if (cached) {
        // Restore Date objects from JSON
        cached.createdAt = new Date(cached.createdAt);
        cached.updatedAt = new Date(cached.updatedAt);
        if (cached.lastSyncedAt) cached.lastSyncedAt = new Date(cached.lastSyncedAt);
        return cached;
      }
    }

    // Try to fetch existing balance
    const stmt = this.db.prepare(
      `SELECT id, employee_id, location_id, balance_type, current_balance, hcm_version, last_synced_at, created_at, updated_at
       FROM balances
       WHERE employee_id = ? AND location_id = ? AND balance_type = ?`
    );

    const row = stmt.get(employeeId, locationId, balanceType) as any;

    if (row) {
      const balance: Balance = {
        id: row.id,
        employeeId: row.employee_id,
        locationId: row.location_id,
        balanceType: row.balance_type,
        currentBalance: row.current_balance,
        hcmVersion: row.hcm_version,
        lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at) : undefined,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at)
      };
      if (this.cache) await this.cache.set(cacheKey, balance);
      return balance;
    }

    // Create new balance if not exists (default to 0)
    const id = uuidv4();
    const now = new Date();
    const insertStmt = this.db.prepare(
      `INSERT INTO balances (id, employee_id, location_id, balance_type, current_balance, hcm_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    insertStmt.run(id, employeeId, locationId, balanceType, 0, 1, now.toISOString(), now.toISOString());

    const newBalance: Balance = {
      id,
      employeeId,
      locationId,
      balanceType,
      currentBalance: 0,
      hcmVersion: 1,
      createdAt: now,
      updatedAt: now
    };
    if (this.cache) await this.cache.set(cacheKey, newBalance);
    return newBalance;
  }

  /**
   * Deduct balance with optimistic locking
   * Prevents race conditions and double-deduction
   */
  async deductBalance(
    employeeId: string,
    locationId: string,
    balanceType: BalanceType,
    amount: number,
    expectedVersion: number
  ): Promise<Balance> {
    // Get current balance
    const stmt = this.db.prepare(
      `SELECT id, current_balance, hcm_version
       FROM balances
       WHERE employee_id = ? AND location_id = ? AND balance_type = ?`
    );

    const row = stmt.get(employeeId, locationId, balanceType) as any;

    if (!row) {
      throw new Error(`Balance not found for ${employeeId} at ${locationId}`);
    }

    // Check version (optimistic locking)
    if (row.hcm_version !== expectedVersion) {
      throw new Error(
        `Version mismatch: expected ${expectedVersion}, got ${row.hcm_version}. Concurrent modification detected.`
      );
    }

    const newBalance = row.current_balance - amount;

    // Check sufficient balance (unless it's a refund)
    if (amount > 0 && newBalance < 0) {
      throw new Error(`Insufficient balance: ${row.current_balance} < ${amount}`);
    }

    // Update with version check (optimistic locking)
    const updateStmt = this.db.prepare(
      `UPDATE balances
       SET current_balance = ?, hcm_version = hcm_version + 1, updated_at = ?
       WHERE id = ? AND hcm_version = ?`
    );

    const now = new Date();
    const changes = updateStmt.run(newBalance, now.toISOString(), row.id, expectedVersion).changes;

    if (changes === 0) {
      throw new Error('Version mismatch: concurrent modification detected');
    }

    // Create audit log
    this.createAuditLog('balance', row.id, amount > 0 ? 'deducted' : 'refunded', null, {
      employeeId,
      locationId,
      balanceType,
      amount,
      previousBalance: row.current_balance,
      newBalance,
      hcmVersion: expectedVersion + 1
    });

    // Invalidate cache
    await this.invalidateBalanceCache(employeeId, locationId, balanceType);

    // Fetch and return updated balance
    return this.getBalance(employeeId, locationId, balanceType);
  }

  /**
   * Batch update multiple balances (for daily sync)
   * Location-aware: treats each location independently
   */
  async batchUpdateBalances(
    updates: Array<{ employeeId: string; locationId: string; balanceType: BalanceType; balance: number; version: number }>
  ): Promise<{ success: boolean; updatedCount: number; failedCount: number }> {
    let updatedCount = 0;
    let failedCount = 0;

    const insertOrUpdateStmt = this.db.prepare(
      `INSERT INTO balances (id, employee_id, location_id, balance_type, current_balance, hcm_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(employee_id, location_id, balance_type) DO UPDATE SET
         current_balance = excluded.current_balance,
         hcm_version = excluded.hcm_version,
         updated_at = excluded.updated_at`
    );

    const now = new Date();

    for (const update of updates) {
      try {
        const existingBalance = this.db
          .prepare(
            `SELECT id FROM balances
             WHERE employee_id = ? AND location_id = ? AND balance_type = ?`
          )
          .get(update.employeeId, update.locationId, update.balanceType) as any;

        const id = existingBalance?.id || uuidv4();

        insertOrUpdateStmt.run(
          id,
          update.employeeId,
          update.locationId,
          update.balanceType,
          update.balance,
          update.version,
          now.toISOString(),
          now.toISOString()
        );

        updatedCount++;

        // Invalidate cache for this balance
        await this.invalidateBalanceCache(update.employeeId, update.locationId, update.balanceType);

        // Create audit log for each update
        this.createAuditLog('balance', id, 'batch_sync_updated', null, {
          employeeId: update.employeeId,
          locationId: update.locationId,
          balanceType: update.balanceType,
          newBalance: update.balance,
          hcmVersion: update.version
        });
      } catch (error) {
        console.error(`Failed to update balance for ${update.employeeId}@${update.locationId}:`, error);
        failedCount++;
      }
    }

    return {
      success: failedCount === 0,
      updatedCount,
      failedCount
    };
  }

  /**
   * Detect divergence between local and HCM values
   */
  async detectDivergence(
    localBalance: number,
    hcmBalance: number,
    daysRequested: number
  ): Promise<Divergence> {
    if (localBalance === hcmBalance) {
      return { detected: false };
    }

    const type = hcmBalance > localBalance ? 'increase' : 'decrease';
    const isValid = hcmBalance >= daysRequested;

    return {
      detected: true,
      type,
      previousBalance: localBalance,
      currentBalance: hcmBalance,
      isValid
    };
  }

  /**
   * Create audit log entry
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

  /**
   * Update last sync timestamp
   */
  async updateLastSyncedAt(employeeId: string, locationId: string, balanceType: BalanceType): Promise<void> {
    const stmt = this.db.prepare(
      `UPDATE balances
       SET last_synced_at = ?
       WHERE employee_id = ? AND location_id = ? AND balance_type = ?`
    );

    stmt.run(new Date().toISOString(), employeeId, locationId, balanceType);
  }

  /**
   * Get all balances for employee (multi-location)
   */
  async getAllBalancesForEmployee(employeeId: string): Promise<Balance[]> {
    // Check cache
    const cacheKey = `balances:employee:${employeeId}`;
    if (this.cache) {
      const cached = await this.cache.get<Balance[]>(cacheKey);
      if (cached) {
        return cached.map((b) => ({
          ...b,
          createdAt: new Date(b.createdAt),
          updatedAt: new Date(b.updatedAt),
          lastSyncedAt: b.lastSyncedAt ? new Date(b.lastSyncedAt) : undefined
        }));
      }
    }

    const stmt = this.db.prepare(
      `SELECT id, employee_id, location_id, balance_type, current_balance, hcm_version, last_synced_at, created_at, updated_at
       FROM balances
       WHERE employee_id = ?
       ORDER BY location_id, balance_type`
    );

    const rows = stmt.all(employeeId) as any[];

    const balances = rows.map((row) => ({
      id: row.id,
      employeeId: row.employee_id,
      locationId: row.location_id,
      balanceType: row.balance_type,
      currentBalance: row.current_balance,
      hcmVersion: row.hcm_version,
      lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    }));

    if (this.cache) await this.cache.set(cacheKey, balances);
    return balances;
  }

  /**
   * Invalidate cache for a specific balance and the employee's list cache
   */
  async invalidateBalanceCache(employeeId: string, locationId: string, balanceType: BalanceType): Promise<void> {
    if (!this.cache) return;
    await this.cache.del(`balance:${employeeId}:${locationId}:${balanceType}`);
    await this.cache.del(`balances:employee:${employeeId}`);
  }
}
