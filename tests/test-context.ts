/**
 * Global Test Context
 * Manages mock HCM server instance shared across all tests.
 * Uses reference counting so the server starts once and stops
 * when the last test suite tears down.
 */

import MockHCMServer from './fixtures/mock-hcm';

let mockHcmServer: MockHCMServer | null = null;
let initializationPromise: Promise<MockHCMServer> | null = null;
let refCount = 0;

export async function initializeMockHCMServer(): Promise<MockHCMServer> {
  refCount++;

  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    mockHcmServer = new MockHCMServer({
      port: 3001,
      deterministic: true,
      approvalDelayMs: 100
    });
    await mockHcmServer.start();
    return mockHcmServer;
  })();

  return initializationPromise;
}

export function getMockHCMServerInstance(): MockHCMServer | null {
  return mockHcmServer;
}

export async function shutdownMockHCMServer(): Promise<void> {
  refCount--;
  if (refCount <= 0 && mockHcmServer) {
    await mockHcmServer.stop();
    mockHcmServer = null;
    initializationPromise = null;
    refCount = 0;
  }
}
