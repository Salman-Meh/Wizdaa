/**
 * Mock HCM Server
 * Simulates HCM API for testing purposes
 * Supports configurable behavior: delays, errors, deterministic values
 */
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
    errorRate: number;
    deterministic: boolean;
    timeoutRate: number;
}
declare class MockHCMServer {
    private balances;
    private submissions;
    private config;
    private server?;
    private submissionHistory;
    private balanceHistory;
    constructor(config?: Partial<MockHCMConfig>);
    private initializeTestData;
    private getBalanceKey;
    private setBalance;
    private shouldError;
    private shouldTimeout;
    private getApprovalDelay;
    start(): Promise<void>;
    stop(): Promise<void>;
    private handleRequest;
    private handleGetBalance;
    private handleBatchBalances;
    private handleSubmitRequest;
    private handleGetSubmissionStatus;
    private handleForceApprove;
    private handleForceReject;
    private handleReset;
    private handleGetHistory;
    forceApprove(submissionId: string): void;
    forceReject(submissionId: string): void;
    updateBalance(employeeId: string, locationId: string, balanceType: string, newBalance: number): void;
    getSubmission(submissionId: string): Submission | undefined;
    getAllSubmissions(): Submission[];
    reset(): void;
}
export { MockHCMServer };
export default MockHCMServer;
//# sourceMappingURL=mock-hcm.d.ts.map