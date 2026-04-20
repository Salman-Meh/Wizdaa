/**
 * Global Test Context
 * Manages mock HCM server instance shared across all tests.
 * Uses reference counting so the server starts once and stops
 * when the last test suite tears down.
 */
import MockHCMServer from './fixtures/mock-hcm';
export declare function initializeMockHCMServer(): Promise<MockHCMServer>;
export declare function getMockHCMServerInstance(): MockHCMServer | null;
export declare function shutdownMockHCMServer(): Promise<void>;
//# sourceMappingURL=test-context.d.ts.map