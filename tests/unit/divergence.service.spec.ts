/**
 * Unit Tests: DivergenceService
 * Tests divergence detection, auto-reconciliation logic, and audit logging
 */

import Database from 'better-sqlite3';
import { DivergenceService } from '../../src/services/divergence.service';
import { Divergence } from '../../src/models/types';

describe('DivergenceService', () => {
  let db: Database.Database;
  let service: DivergenceService;

  beforeEach(() => {
    db = new Database(':memory:');

    // Create audit_logs table for logDivergence tests
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        actor TEXT,
        details TEXT,
        created_at TEXT NOT NULL
      )
    `);

    service = new DivergenceService(db);
  });

  afterEach(() => {
    db.close();
  });

  // ===== detectDivergence =====

  describe('detectDivergence', () => {
    test('should return no divergence when balances match', () => {
      const result = service.detectDivergence(10, 10, 5);
      expect(result).toEqual({ detected: false });
    });

    test('should detect balance increase', () => {
      const result = service.detectDivergence(10, 15, 5);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('increase');
      expect(result.previousBalance).toBe(10);
      expect(result.currentBalance).toBe(15);
      expect(result.isValid).toBe(true);
    });

    test('should detect valid balance decrease (still enough for request)', () => {
      const result = service.detectDivergence(10, 7, 5);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('decrease');
      expect(result.previousBalance).toBe(10);
      expect(result.currentBalance).toBe(7);
      expect(result.isValid).toBe(true);
    });

    test('should detect invalid balance decrease (insufficient for request)', () => {
      const result = service.detectDivergence(10, 3, 5);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('decrease');
      expect(result.previousBalance).toBe(10);
      expect(result.currentBalance).toBe(3);
      expect(result.isValid).toBe(false);
    });

    test('should handle zero balance', () => {
      const result = service.detectDivergence(5, 0, 3);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('decrease');
      expect(result.isValid).toBe(false);
    });

    test('should handle exact match between current balance and days requested', () => {
      const result = service.detectDivergence(10, 5, 5);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('decrease');
      expect(result.isValid).toBe(true); // exactly enough
    });

    test('should generate reason for increase', () => {
      const result = service.detectDivergence(10, 15, 5);
      expect(result.reason).toContain('increased from 10 to 15');
      expect(result.reason).toContain('+5');
    });

    test('should generate reason for valid decrease', () => {
      const result = service.detectDivergence(10, 7, 5);
      expect(result.reason).toContain('decreased from 10 to 7');
      expect(result.reason).toContain('-3');
      expect(result.reason).toContain('Do you want to proceed?');
    });

    test('should generate reason for invalid decrease', () => {
      const result = service.detectDivergence(10, 3, 5);
      expect(result.reason).toContain('decreased from 10 to 3');
      expect(result.reason).toContain('Insufficient balance');
      expect(result.reason).toContain('Cancelling request');
    });
  });

  // ===== canAutoReconcile =====

  describe('canAutoReconcile', () => {
    test('should auto-reconcile when no divergence', () => {
      const divergence: Divergence = { detected: false };
      expect(service.canAutoReconcile(divergence)).toBe(true);
    });

    test('should auto-reconcile balance increases (employee benefit)', () => {
      const divergence: Divergence = {
        detected: true,
        type: 'increase',
        previousBalance: 10,
        currentBalance: 15,
        isValid: true,
      };
      expect(service.canAutoReconcile(divergence)).toBe(true);
    });

    test('should auto-reconcile invalid decreases (auto-reject)', () => {
      const divergence: Divergence = {
        detected: true,
        type: 'decrease',
        previousBalance: 10,
        currentBalance: 3,
        isValid: false,
      };
      expect(service.canAutoReconcile(divergence)).toBe(true);
    });

    test('should NOT auto-reconcile valid decreases (needs employee confirmation)', () => {
      const divergence: Divergence = {
        detected: true,
        type: 'decrease',
        previousBalance: 10,
        currentBalance: 7,
        isValid: true,
      };
      expect(service.canAutoReconcile(divergence)).toBe(false);
    });
  });

  // ===== logDivergence =====

  describe('logDivergence', () => {
    test('should insert audit log for divergence', () => {
      const divergence: Divergence = {
        detected: true,
        type: 'increase',
        previousBalance: 10,
        currentBalance: 15,
        isValid: true,
        reason: 'Balance increased',
      };

      service.logDivergence('REQ-001', divergence, 'system');

      const row = db.prepare(
        `SELECT * FROM audit_logs WHERE entity_id = ? AND event_type = 'divergence_detected'`
      ).get('REQ-001') as any;

      expect(row).toBeDefined();
      expect(row.entity_type).toBe('request');
      expect(row.entity_id).toBe('REQ-001');
      expect(row.actor).toBe('system');

      const details = JSON.parse(row.details);
      expect(details.type).toBe('increase');
      expect(details.previousBalance).toBe(10);
      expect(details.currentBalance).toBe(15);
      expect(details.isValid).toBe(true);
    });

    test('should use default actor when not specified', () => {
      const divergence: Divergence = {
        detected: true,
        type: 'decrease',
        previousBalance: 10,
        currentBalance: 5,
        isValid: true,
      };

      service.logDivergence('REQ-002', divergence);

      const row = db.prepare(
        `SELECT actor FROM audit_logs WHERE entity_id = ?`
      ).get('REQ-002') as any;

      expect(row.actor).toBe('system');
    });
  });

  // ===== getDivergenceStats =====

  describe('getDivergenceStats', () => {
    test('should return zeros when no divergences exist', () => {
      const stats = service.getDivergenceStats(24);
      expect(stats.total).toBe(0);
      expect(stats.increases).toBe(0);
      expect(stats.decreases).toBe(0);
    });

    test('should count divergences within time window', () => {
      // Insert some divergence logs
      service.logDivergence('REQ-A', {
        detected: true,
        type: 'increase',
        previousBalance: 10,
        currentBalance: 15,
        isValid: true,
      });

      service.logDivergence('REQ-B', {
        detected: true,
        type: 'decrease',
        previousBalance: 10,
        currentBalance: 5,
        isValid: true,
      });

      service.logDivergence('REQ-C', {
        detected: true,
        type: 'decrease',
        previousBalance: 10,
        currentBalance: 3,
        isValid: false,
      });

      const stats = service.getDivergenceStats(24);
      expect(stats.total).toBe(3);
      expect(stats.increases).toBe(1);
      expect(stats.decreases).toBe(2);
    });

    test('should exclude old divergences outside time window', () => {
      // Insert a recent one
      service.logDivergence('REQ-RECENT', {
        detected: true,
        type: 'increase',
        previousBalance: 10,
        currentBalance: 15,
        isValid: true,
      });

      // Insert an old one manually (2 days ago)
      const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      db.prepare(
        `INSERT INTO audit_logs (id, entity_type, entity_id, event_type, actor, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('old-id', 'request', 'REQ-OLD', 'divergence_detected', 'system',
        JSON.stringify({ type: 'decrease', previousBalance: 10, currentBalance: 5 }),
        oldTime
      );

      const stats = service.getDivergenceStats(24);
      expect(stats.total).toBe(1);
      expect(stats.increases).toBe(1);
    });
  });
});
