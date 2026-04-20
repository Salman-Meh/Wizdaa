/**
 * Mock HCM Server
 * Simulates HCM API for testing purposes
 * Supports configurable behavior: delays, errors, deterministic values
 */

import * as http from 'http';
import { v4 as uuidv4 } from 'uuid';

interface Balance {
  employeeId: string;
  locationId: string;
  balanceType: string;
  balance: number;
  hcmVersion: number;
  lastUpdatedAt: Date;
}

interface Submission {
  submissionId: string;
  employeeId: string;
  locationId: string;
  balanceType: string;
  daysRequested: number;
  status: 'processing' | 'approved' | 'rejected';
  createdAt: Date;
  resultAt?: Date;
}

interface MockHCMConfig {
  port: number;
  approvalDelayMs: number;
  errorRate: number; // 0.0 - 1.0
  deterministic: boolean;
  timeoutRate: number;
}

class MockHCMServer {
  private balances: Map<string, Balance> = new Map();
  private submissions: Map<string, Submission> = new Map();
  private config: MockHCMConfig;
  private server?: http.Server;
  private submissionHistory: Submission[] = [];
  private balanceHistory: Array<{ balance: Balance; action: string; timestamp: Date }> = [];

  constructor(config: Partial<MockHCMConfig> = {}) {
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

  private initializeTestData() {
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

  private getBalanceKey(employeeId: string, locationId: string, balanceType: string): string {
    return `${employeeId}:${locationId}:${balanceType}`;
  }

  private setBalance(
    employeeId: string,
    locationId: string,
    balanceType: string,
    balance: number,
    version: number
  ): Balance {
    const key = this.getBalanceKey(employeeId, locationId, balanceType);
    const balanceRecord: Balance = {
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

  private shouldError(): boolean {
    return Math.random() < this.config.errorRate;
  }

  private shouldTimeout(): boolean {
    return Math.random() < this.config.timeoutRate;
  }

  private getApprovalDelay(): number {
    if (this.config.deterministic) {
      return this.config.approvalDelayMs;
    }
    // Random between 5-30 seconds
    return Math.random() * 25000 + 5000;
  }

  start(): Promise<void> {
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

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log('Mock HCM Server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
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

  private handleGetBalance(employeeId: string, locationId: string, res: http.ServerResponse) {
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
    const balances: any = {
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

  private handleBatchBalances(res: http.ServerResponse) {
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

  private handleSubmitRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const submissionId = uuidv4();

        if (this.shouldError()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid request' }));
          return;
        }

        const submission: Submission = {
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
        res.end(
          JSON.stringify({
            submissionId,
            status: 'received',
            createdAt: submission.createdAt.toISOString()
          })
        );
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }

  private handleGetSubmissionStatus(submissionId: string, res: http.ServerResponse) {
    const submission = this.submissions.get(submissionId);

    if (!submission) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Submission not found' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        submissionId,
        status: submission.status,
        createdAt: submission.createdAt.toISOString(),
        resultAt: submission.resultAt?.toISOString()
      })
    );
  }

  private handleForceApprove(submissionId: string, res: http.ServerResponse) {
    const submission = this.submissions.get(submissionId);
    if (submission) {
      submission.status = 'approved';
      submission.resultAt = new Date();
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'forced', result: 'approved' }));
  }

  private handleForceReject(submissionId: string, res: http.ServerResponse) {
    const submission = this.submissions.get(submissionId);
    if (submission) {
      submission.status = 'rejected';
      submission.resultAt = new Date();
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'forced', result: 'rejected' }));
  }

  private handleReset(res: http.ServerResponse) {
    this.balances.clear();
    this.submissions.clear();
    this.submissionHistory = [];
    this.balanceHistory = [];
    this.initializeTestData();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'reset' }));
  }

  private handleGetHistory(res: http.ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        submissions: this.submissionHistory,
        balanceUpdates: this.balanceHistory.length,
        timestamp: new Date().toISOString()
      })
    );
  }

  // Public API for test utilities
  forceApprove(submissionId: string) {
    const submission = this.submissions.get(submissionId);
    if (submission) {
      submission.status = 'approved';
      submission.resultAt = new Date();
    }
  }

  forceReject(submissionId: string) {
    const submission = this.submissions.get(submissionId);
    if (submission) {
      submission.status = 'rejected';
      submission.resultAt = new Date();
    }
  }

  updateBalance(employeeId: string, locationId: string, balanceType: string, newBalance: number) {
    const key = this.getBalanceKey(employeeId, locationId, balanceType);
    const current = this.balances.get(key);
    if (current) {
      this.setBalance(employeeId, locationId, balanceType, newBalance, current.hcmVersion + 1);
    }
  }

  getSubmission(submissionId: string): Submission | undefined {
    return this.submissions.get(submissionId);
  }

  getAllSubmissions(): Submission[] {
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

// Standalone server — start when run directly
if (require.main === module) {
  const server = new MockHCMServer({
    port: parseInt(process.env.MOCK_HCM_PORT || '3001'),
    deterministic: true
  });
  server.start();
}

export { MockHCMServer };
export default MockHCMServer;
