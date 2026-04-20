/**
 * Test Setup and Utilities
 */
import Database from 'better-sqlite3';
/**
 * Initialize test environment
 */
export declare function setupTestEnvironment(): Promise<void>;
/**
 * Cleanup test environment
 */
export declare function teardownTestEnvironment(): Promise<void>;
/**
 * Get test database connection
 */
export declare function getTestDatabase(): Database.Database;
/**
 * Get mock HCM server
 */
export declare function getMockHCMServer(): import("./fixtures/mock-hcm").MockHCMServer | null;
/**
 * Reset test state
 */
export declare function resetTestState(): Promise<void>;
//# sourceMappingURL=setup.d.ts.map