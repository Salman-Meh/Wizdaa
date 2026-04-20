"use strict";
/**
 * Mock HCM Server
 * Simulates HCM API for testing purposes
 * Supports configurable behavior: delays, errors, deterministic values
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockHCMServer = void 0;
const http = __importStar(require("http"));
const uuid_1 = require("uuid");
class MockHCMServer {
    constructor(config = {}) {
        this.balances = new Map();
        this.submissions = new Map();
        this.submissionHistory = [];
        this.balanceHistory = [];
        this.config = {
            port: 3001,
            approvalDelayMs: 5000,
            errorRate: 0,
            deterministic: false,
            timeoutRate: 0,
            ...config
        };
        // Initialize test data
        this.initializeTestData();
    }
    initializeTestData() {
        // Single location employee
        this.setBalance('E001', 'NYC', 'vacation', 20, 1);
        this.setBalance('E001', 'NYC', 'sick', 10, 1);
        // Multi-location employee
        this.setBalance('E002', 'NYC', 'vacation', 20, 1);
        this.setBalance('E002', 'NYC', 'sick', 10, 1);
        this.setBalance('E002', 'LA', 'vacation', 15, 1);
        this.setBalance('E002', 'LA', 'sick', 8, 1);
        this.setBalance('E002', 'Chicago', 'vacation', 18, 1);
        this.setBalance('E002', 'Chicago', 'sick', 9, 1);
        // Additional test employees
        for (let i = 3; i <= 10; i++) {
            this.setBalance(`E00${i}`, 'NYC', 'vacation', 20 - i, 1);
            this.setBalance(`E00${i}`, 'NYC', 'sick', 10, 1);
        }
    }
    getBalanceKey(employeeId, locationId, balanceType) {
        return `${employeeId}:${locationId}:${balanceType}`;
    }
    setBalance(employeeId, locationId, balanceType, balance, version) {
        const key = this.getBalanceKey(employeeId, locationId, balanceType);
        const balanceRecord = {
            employeeId,
            locationId,
            balanceType,
            balance,
            hcmVersion: version,
            lastUpdatedAt: new Date()
        };
        this.balances.set(key, balanceRecord);
        this.balanceHistory.push({ balance: balanceRecord, action: 'updated', timestamp: new Date() });
        return balanceRecord;
    }
    shouldError() {
        return Math.random() < this.config.errorRate;
    }
    shouldTimeout() {
        return Math.random() < this.config.timeoutRate;
    }
    getApprovalDelay() {
        if (this.config.deterministic) {
            return this.config.approvalDelayMs;
        }
        // Random between 5-30 seconds
        return Math.random() * 25000 + 5000;
    }
    start() {
        return new Promise((resolve) => {
            this.server = http.createServer((req, res) => {
                this.handleRequest(req, res);
            });
            this.server.listen(this.config.port, () => {
                console.log(`Mock HCM Server listening on port ${this.config.port}`);
                resolve();
            });
        });
    }
    stop() {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    console.log('Mock HCM Server stopped');
                    resolve();
                });
            }
            else {
                resolve();
            }
        });
    }
    handleRequest(req, res) {
        const url = req.url || '';
        const method = req.method || 'GET';
        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }
        // Health check
        if (url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
            return;
        }
        // Real-time balance API
        if (url.match(/^\/api\/balances\/[\w-]+\/[\w-]+$/)) {
            const parts = url.split('/');
            const employeeId = parts[3];
            const locationId = parts[4];
            this.handleGetBalance(employeeId, locationId, res);
            return;
        }
        // Batch balance API
        if (url === '/api/balances/batch' || url === '/api/balances?all=true') {
            this.handleBatchBalances(res);
            return;
        }
        // Submit request to HCM
        if (url === '/api/submissions' && method === 'POST') {
            this.handleSubmitRequest(req, res);
            return;
        }
        // Get submission status
        if (url.match(/^\/api\/submissions\/[\w-]+$/)) {
            const submissionId = url.split('/')[3];
            this.handleGetSubmissionStatus(submissionId, res);
            return;
        }
        // Test utilities
        if (url.match(/^\/test-utils\/force-approve\//)) {
            const submissionId = url.split('/')[3];
            this.handleForceApprove(submissionId, res);
            return;
        }
        if (url.match(/^\/test-utils\/force-reject\//)) {
            const submissionId = url.split('/')[3];
            this.handleForceReject(submissionId, res);
            return;
        }
        if (url === '/test-utils/reset' && method === 'POST') {
            this.handleReset(res);
            return;
        }
        if (url === '/test-utils/history') {
            this.handleGetHistory(res);
            return;
        }
        // 404
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }
    handleGetBalance(employeeId, locationId, res) {
        if (this.shouldError()) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Service unavailable' }));
            return;
        }
        if (this.shouldTimeout()) {
            // Simulate timeout by not responding
            setTimeout(() => {
                res.writeHead(504, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Timeout' }));
            }, 10000);
            return;
        }
        // Return all balance types for this employee-location
        const balances = {
            employeeId,
            locationId,
            balances: {}
        };
        const balanceTypes = ['vacation', 'sick', 'personal'];
        for (const type of balanceTypes) {
            const key = this.getBalanceKey(employeeId, locationId, type);
            const balance = this.balances.get(key);
            if (balance) {
                balances.balances[type] = {
                    balance: balance.balance,
                    hcmVersion: balance.hcmVersion,
                    lastUpdatedAt: balance.lastUpdatedAt.toISOString()
                };
            }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(balances));
    }
    handleBatchBalances(res) {
        if (this.shouldError()) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Service unavailable' }));
            return;
        }
        const balancesList = Array.from(this.balances.values()).map((b) => ({
            employeeId: b.employeeId,
            locationId: b.locationId,
            balanceType: b.balanceType,
            balance: b.balance,
            hcmVersion: b.hcmVersion,
            lastUpdatedAt: b.lastUpdatedAt.toISOString()
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ balances: balancesList, timestamp: new Date().toISOString() }));
    }
    handleSubmitRequest(req, res) {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const submissionId = (0, uuid_1.v4)();
                if (this.shouldError()) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid request' }));
                    return;
                }
                const submission = {
                    submissionId,
                    employeeId: data.employeeId,
                    locationId: data.locationId,
                    balanceType: data.balanceType,
                    daysRequested: data.daysRequested,
                    status: 'processing',
                    createdAt: new Date()
                };
                this.submissions.set(submissionId, submission);
                this.submissionHistory.push(submission);
                // Auto-approve after delay
                if (this.config.deterministic) {
                    setTimeout(() => {
                        const sub = this.submissions.get(submissionId);
                        if (sub) {
                            sub.status = 'approved';
                            sub.resultAt = new Date();
                        }
                    }, this.config.approvalDelayMs);
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    submissionId,
                    status: 'received',
                    createdAt: submission.createdAt.toISOString()
                }));
            }
            catch (error) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
    }
    handleGetSubmissionStatus(submissionId, res) {
        const submission = this.submissions.get(submissionId);
        if (!submission) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Submission not found' }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            submissionId,
            status: submission.status,
            createdAt: submission.createdAt.toISOString(),
            resultAt: submission.resultAt?.toISOString()
        }));
    }
    handleForceApprove(submissionId, res) {
        const submission = this.submissions.get(submissionId);
        if (submission) {
            submission.status = 'approved';
            submission.resultAt = new Date();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'forced', result: 'approved' }));
    }
    handleForceReject(submissionId, res) {
        const submission = this.submissions.get(submissionId);
        if (submission) {
            submission.status = 'rejected';
            submission.resultAt = new Date();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'forced', result: 'rejected' }));
    }
    handleReset(res) {
        this.balances.clear();
        this.submissions.clear();
        this.submissionHistory = [];
        this.balanceHistory = [];
        this.initializeTestData();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'reset' }));
    }
    handleGetHistory(res) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            submissions: this.submissionHistory,
            balanceUpdates: this.balanceHistory.length,
            timestamp: new Date().toISOString()
        }));
    }
    // Public API for test utilities
    forceApprove(submissionId) {
        const submission = this.submissions.get(submissionId);
        if (submission) {
            submission.status = 'approved';
            submission.resultAt = new Date();
        }
    }
    forceReject(submissionId) {
        const submission = this.submissions.get(submissionId);
        if (submission) {
            submission.status = 'rejected';
            submission.resultAt = new Date();
        }
    }
    updateBalance(employeeId, locationId, balanceType, newBalance) {
        const key = this.getBalanceKey(employeeId, locationId, balanceType);
        const current = this.balances.get(key);
        if (current) {
            this.setBalance(employeeId, locationId, balanceType, newBalance, current.hcmVersion + 1);
        }
    }
    getSubmission(submissionId) {
        return this.submissions.get(submissionId);
    }
    getAllSubmissions() {
        return Array.from(this.submissions.values());
    }
    reset() {
        this.balances.clear();
        this.submissions.clear();
        this.submissionHistory = [];
        this.balanceHistory = [];
        this.initializeTestData();
    }
}
exports.MockHCMServer = MockHCMServer;
// Standalone server — start when run directly
if (require.main === module) {
    const server = new MockHCMServer({
        port: parseInt(process.env.MOCK_HCM_PORT || '3001'),
        deterministic: true
    });
    server.start();
}
exports.default = MockHCMServer;
//# sourceMappingURL=mock-hcm.js.map