/**
 * Global Jest Teardown
 * Runs once after all tests complete
 */

export default async function globalTeardown() {
  const mockHcmServer = (global as any).__mockHcmServer;
  if (mockHcmServer) {
    await mockHcmServer.stop();
    console.log('✓ Global: Mock HCM Server stopped');
  }
}
