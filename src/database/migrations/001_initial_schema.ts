/**
 * Migration 001: Initial Schema
 * Creates all base tables: balances, requests, audit_logs, locations, employees, managers
 */

import Database from 'better-sqlite3';
import { Migration } from '../migrator';

const migration: Migration = {
  name: '001_initial_schema',

  up(db: Database.Database) {
    db.exec(`
      -- Balances Table
      CREATE TABLE IF NOT EXISTS balances (
        id TEXT PRIMARY KEY,
        employee_id VARCHAR(100) NOT NULL,
        location_id VARCHAR(100) NOT NULL,
        balance_type VARCHAR(50) NOT NULL,
        current_balance DECIMAL(10,2) NOT NULL,
        hcm_version INT NOT NULL,
        last_synced_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(employee_id, location_id, balance_type),
        CHECK (current_balance >= 0)
      );

      CREATE INDEX IF NOT EXISTS idx_balance_employee ON balances(employee_id);
      CREATE INDEX IF NOT EXISTS idx_balance_location ON balances(location_id);
      CREATE INDEX IF NOT EXISTS idx_balance_employee_location ON balances(employee_id, location_id);
      CREATE INDEX IF NOT EXISTS idx_balance_updated ON balances(updated_at);

      -- Requests Table
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        employee_id VARCHAR(100) NOT NULL,
        location_id VARCHAR(100) NOT NULL,
        balance_type VARCHAR(50) NOT NULL,
        days_requested DECIMAL(10,2) NOT NULL,
        requested_balance_at_submission DECIMAL(10,2),
        status VARCHAR(50) NOT NULL,
        manager_id VARCHAR(100),
        manager_location_id VARCHAR(100),
        manager_action_at TIMESTAMP,
        manager_reason TEXT,
        hcm_submission_id VARCHAR(100),
        submitted_to_hcm_at TIMESTAMP,
        hcm_approved_at TIMESTAMP,
        divergence_detected_at TIMESTAMP,
        divergence_reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CHECK (days_requested > 0),
        FOREIGN KEY (manager_location_id) REFERENCES locations(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_request_employee ON requests(employee_id);
      CREATE INDEX IF NOT EXISTS idx_request_status ON requests(status);
      CREATE INDEX IF NOT EXISTS idx_request_created ON requests(created_at);
      CREATE INDEX IF NOT EXISTS idx_request_employee_status ON requests(employee_id, status);
      CREATE INDEX IF NOT EXISTS idx_request_hcm_submission ON requests(hcm_submission_id);

      -- Audit Logs Table
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        entity_type VARCHAR(50),
        entity_id TEXT,
        event_type VARCHAR(100),
        actor VARCHAR(50),
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_logs(event_type, created_at);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

      -- Locations Table
      CREATE TABLE IF NOT EXISTS locations (
        id TEXT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        region VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Employees Table
      CREATE TABLE IF NOT EXISTS employees (
        id TEXT PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Managers Table
      CREATE TABLE IF NOT EXISTS managers (
        id TEXT PRIMARY KEY,
        manager_id VARCHAR(100) NOT NULL,
        employee_id VARCHAR(100) NOT NULL,
        location_id VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(manager_id, employee_id, location_id)
      );

      CREATE INDEX IF NOT EXISTS idx_manager_employee ON managers(employee_id);
      CREATE INDEX IF NOT EXISTS idx_manager_location ON managers(manager_id, location_id);
    `);
  },

  down(db: Database.Database) {
    db.exec(`
      DROP TABLE IF EXISTS managers;
      DROP TABLE IF EXISTS employees;
      DROP TABLE IF EXISTS locations;
      DROP TABLE IF EXISTS audit_logs;
      DROP TABLE IF EXISTS requests;
      DROP TABLE IF EXISTS balances;
    `);
  }
};

export default migration;
