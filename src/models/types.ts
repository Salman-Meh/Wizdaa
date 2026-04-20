/**
 * Domain Models and Types
 */

// Balance types
export type BalanceType = 'vacation' | 'sick' | 'personal';

// Request status
export type RequestStatus =
  | 'pending_manager_approval'
  | 'pending_employee_confirmation'
  | 'processing'
  | 'approved'
  | 'rejected';

// Balance Model
export interface Balance {
  id: string;
  employeeId: string;
  locationId: string;
  balanceType: BalanceType;
  currentBalance: number;
  hcmVersion: number;
  lastSyncedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// Request Model
export interface Request {
  id: string;
  employeeId: string;
  locationId: string;
  balanceType: BalanceType;
  daysRequested: number;
  requestedBalanceAtSubmission: number;
  status: RequestStatus;
  managerId?: string;
  managerLocationId?: string;
  managerActionAt?: Date;
  managerReason?: string;
  hcmSubmissionId?: string;
  submittedToHcmAt?: Date;
  hcmApprovedAt?: Date;
  divergenceDetectedAt?: Date;
  divergenceReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Divergence Info
export interface Divergence {
  detected: boolean;
  type?: 'increase' | 'decrease';
  previousBalance?: number;
  currentBalance?: number;
  isValid?: boolean; // Is the request still valid after divergence?
  reason?: string;
}

// Audit Log
export interface AuditLog {
  id: string;
  entityType: 'balance' | 'request' | 'submission';
  entityId: string;
  eventType: string;
  actor?: string;
  details?: Record<string, any>;
  createdAt: Date;
}

// API Request/Response Models

export interface SubmitRequestInput {
  employeeId: string;
  locationId: string;
  balanceType: BalanceType;
  daysRequested: number;
  dates: {
    startDate: Date;
    endDate: Date;
  };
}

export interface SubmitRequestResponse {
  requestId: string;
  status: RequestStatus;
  currentBalance: number;
}

export interface ApproveRequestInput {
  managerId: string;
  managerLocationId: string;
  reason?: string;
}

export interface ApproveRequestResponse {
  requestId: string;
  status: RequestStatus;
  divergence?: Divergence;
}

export interface ConfirmRequestInput {
  action: 'proceed' | 'cancel';
}

export interface GetBalanceResponse {
  employeeId: string;
  locationId?: string;
  locations?: Array<{
    locationId: string;
    balances: Record<BalanceType, number>;
    lastSynced: Date;
  }>;
  balances?: Record<BalanceType, number>;
  lastSynced: Date;
  source: 'hcm' | 'cache' | 'stale';
}

export interface GetRequestStatusResponse {
  requestId: string;
  status: RequestStatus;
  employeeId: string;
  locationId: string;
  balanceType: BalanceType;
  daysRequested: number;
  createdAt: Date;
  updatedAt: Date;
  divergence?: Divergence;
  managerApprovedAt?: Date;
  balanceRemaining?: number;
}
