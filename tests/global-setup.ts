/**
 * Global Jest Setup
 * Runs once before all tests start
 */

import MockHCMServer from './fixtures/mock-hcm';

let mockHcmServer: any;

export default async function globalSetup() {
  // Start mock HCM server once for all tests
  mockHcmServer = new MockHCMServer({
    port: 3001,
    deterministic: true,
    approvalDelayMs: 100
  });

  await mockHcmServer.start();
  console.log('✓ Global: Mock HCM Server started on port 3001');

  // Store server instance globally for teardown
  (global as any).__mockHcmServer = mockHcmServer;
}
