"use strict";
/**
 * Global Test Context
 * Manages mock HCM server instance shared across all tests.
 * Uses reference counting so the server starts once and stops
 * when the last test suite tears down.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeMockHCMServer = initializeMockHCMServer;
exports.getMockHCMServerInstance = getMockHCMServerInstance;
exports.shutdownMockHCMServer = shutdownMockHCMServer;
const mock_hcm_1 = __importDefault(require("./fixtures/mock-hcm"));
let mockHcmServer = null;
let initializationPromise = null;
let refCount = 0;
async function initializeMockHCMServer() {
    refCount++;
    if (initializationPromise) {
        return initializationPromise;
    }
    initializationPromise = (async () => {
        mockHcmServer = new mock_hcm_1.default({
            port: 3001,
            deterministic: true,
            approvalDelayMs: 100
        });
        await mockHcmServer.start();
        return mockHcmServer;
    })();
    return initializationPromise;
}
function getMockHCMServerInstance() {
    return mockHcmServer;
}
async function shutdownMockHCMServer() {
    refCount--;
    if (refCount <= 0 && mockHcmServer) {
        await mockHcmServer.stop();
        mockHcmServer = null;
        initializationPromise = null;
        refCount = 0;
    }
}
//# sourceMappingURL=test-context.js.map