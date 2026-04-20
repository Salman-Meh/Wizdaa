/**
 * Test Setup and Utilities
 */

import DatabaseConnection from '../src/database/database';
import Database from 'better-sqlite3';
import { initializeMockHCMServer, getMockHCMServerInstance, shutdownMockHCMServer } from './test-context';

let dbConnection: DatabaseConnection;

/**
 * Initialize test data (locations, employees, managers)
 */
function initializeTestData(db: Database.Database) {
  // Insert locations
  const insertLocation = db.prepare(`
    INSERT OR IGNORE INTO locations (id, name, region)
    VALUES (?, ?, ?)
  `);

  insertLocation.run('NYC', 'New York', 'North America');
  insertLocation.run('LA', 'Los Angeles', 'North America');
  insertLocation.run('LON', 'London', 'Europe');

  // Insert employees
  const insertEmployee = db.prepare(`
    INSERT OR IGNORE INTO employees (id, name, email)
    VALUES (?, ?, ?)
  `);

  insertEmployee.run('E001', 'John Doe', 'john@example.com');
  insertEmployee.run('E002', 'Jane Smith', 'jane@example.com');
  insertEmployee.run('E_HAPPY_001', 'Test Employee', 'test@example.com');

  // Insert manager-employee relationships
  const insertManager = db.prepare(`
    INSERT OR IGNORE INTO managers (id, manager_id, employee_id, location_id)
    VALUES (?, ?, ?, ?)
  `);

  const generateId = () => Math.random().toString(36).substring(7);

  // Managers for NYC
  insertManager.run(generateId(), 'M_NYC_001', 'E001', 'NYC');
  insertManager.run(generateId(), 'M_NYC_001', 'E_HAPPY_001', 'NYC');

  // Managers for LA
  insertManager.run(generateId(), 'M_LA_001', 'E002', 'LA');

  // Managers for London
  insertManager.run(generateId(), 'M_LON_001', 'E001', 'LON');
}

/**
 * Initialize test environment
 */
export async function setupTestEnvironment() {
  // Use in-memory database for tests
  dbConnection = new DatabaseConnection(':memory:');
  await dbConnection.initialize();

  // Initialize mock HCM server (singleton, shared across tests)
  await initializeMockHCMServer();

  // Initialize test data
  const db = dbConnection.getDatabase();
  initializeTestData(db);
}

/**
 * Cleanup test environment
 */
export async function teardownTestEnvironment() {
  await dbConnection.close();
  await shutdownMockHCMServer();
}

/**
 * Get test database connection
 */
export function getTestDatabase(): Database.Database {
  return dbConnection.getDatabase();
}

/**
 * Get mock HCM server
 */
export function getMockHCMServer() {
  return getMockHCMServerInstance();
}

/**
 * Reset test state
 */
export async function resetTestState() {
  const mockHcm = getMockHCMServer();
  if (mockHcm) {
    mockHcm.reset();
  }
  await dbConnection.reset();

  // Reinitialize test data after reset
  const db = dbConnection.getDatabase();
  initializeTestData(db);
}

