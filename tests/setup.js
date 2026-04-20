"use strict";
/**
 * Test Setup and Utilities
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupTestEnvironment = setupTestEnvironment;
exports.teardownTestEnvironment = teardownTestEnvironment;
exports.getTestDatabase = getTestDatabase;
exports.getMockHCMServer = getMockHCMServer;
exports.resetTestState = resetTestState;
const database_1 = __importDefault(require("../src/database/database"));
const test_context_1 = require("./test-context");
let dbConnection;
/**
 * Initialize test data (locations, employees, managers)
 */
function initializeTestData(db) {
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
async function setupTestEnvironment() {
    // Use in-memory database for tests
    dbConnection = new database_1.default(':memory:');
    await dbConnection.initialize();
    // Initialize mock HCM server (singleton, shared across tests)
    await (0, test_context_1.initializeMockHCMServer)();
    // Initialize test data
    const db = dbConnection.getDatabase();
    initializeTestData(db);
}
/**
 * Cleanup test environment
 */
async function teardownTestEnvironment() {
    await dbConnection.close();
    await (0, test_context_1.shutdownMockHCMServer)();
}
/**
 * Get test database connection
 */
function getTestDatabase() {
    return dbConnection.getDatabase();
}
/**
 * Get mock HCM server
 */
function getMockHCMServer() {
    return (0, test_context_1.getMockHCMServerInstance)();
}
/**
 * Reset test state
 */
async function resetTestState() {
    const mockHcm = getMockHCMServer();
    if (mockHcm) {
        mockHcm.reset();
    }
    await dbConnection.reset();
    // Reinitialize test data after reset
    const db = dbConnection.getDatabase();
    initializeTestData(db);
}
//# sourceMappingURL=setup.js.map