# Time-Off Microservice - Technical Requirements Document

## 1. Executive Summary

This document specifies the Technical Requirements for the **Time-Off Microservice**, a backend system that manages time-off request lifecycles while maintaining balance integrity between two independent systems: ExampleHR (frontend) and HCM (Human Capital Management system, source of truth).

### Problem
Keeping balances synchronized between ExampleHR and HCM is notoriously difficult because:
- HCM updates balances independently (work anniversaries, policy refreshes, start-of-year allocations)
- Employees expect instant feedback on requests in ExampleHR
- Managers must approve requests with confidence that the balance data is valid
- Divergences between systems must be detected and reconciled automatically

### Solution
A dedicated microservice that:
- Caches balances locally (synchronized daily via batch API, validated on each request)
- Manages the complete request lifecycle (pending manager approval → HCM processing → approved/rejected)
- Detects balance divergences and auto-reconciles with employee notification
- Handles race conditions and stuck requests gracefully
- Provides defensive validation (doesn't trust HCM errors blindly)

### Key Metrics
- **Availability**: 99.5% uptime SLA
- **API Latency**: <100ms for request submission (async HCM processing)
- **Code Coverage**: 80% minimum, 85%+ for service logic
- **Balance Accuracy**: 100% (HCM is source of truth)
- **Scale**: Supports 50k+ employees, millions of requests/year

---

## 2. Problem Statement

### Context
ExampleHR serves as the primary interface for employees to request time off. However, the HCM system (Workday, SAP, or similar) remains the authoritative source of truth for employment data, including time-off balances.

Two critical requirements create complexity:

1. **Balances are per-employee-per-location**: Employee "John" might have different vacation days at the NYC location vs. LA location. This dimensionality (employee × location × balance_type) requires careful cache management.

2. **HCM updates independently**: Beyond employee submissions, HCM updates balances for:
   - Work anniversaries (e.g., "+5 vacation days on hire date anniversary")
   - Start-of-year refreshes (e.g., "+20 vacation days on Jan 1")
   - Policy changes (e.g., "all employees in Texas now get +3 days")
   - Manual corrections by HR admins

### User Personas

**The Employee**
- Wants to see an accurate balance when viewing their profile
- Wants instant feedback when submitting a request ("Submitted successfully")
- Wants clarity when circumstances change (e.g., "Your balance updated. Do you want to proceed?")

**The Manager**
- Needs to approve requests with confidence that the balance data is valid
- Needs visibility when divergences occur (especially if they affect pending requests)
- Needs simple, unblocked approval workflows (no excessive confirmations)

### Core Goals
1. **Manage the lifecycle of a time-off request**: From submission through manager approval to HCM processing
2. **Maintain balance integrity**: No lost updates, no double-deductions, consistent with HCM
3. **Provide instant feedback**: Employee sees confirmation within milliseconds
4. **Handle divergence gracefully**: Auto-reconcile when safe, alert when risky

---

## 3. System Architecture

### High-Level Design

```
┌──────────────────────────────────────────────────────────┐
│                      ExampleHR Frontend                  │
│  ┌──────────────────┐  ┌──────────────────┐              │
│  │ Employee Portal  │  │ Manager Portal   │              │
│  └────────┬─────────┘  └─────────┬────────┘              │
└───────────┼──────────────────────┼───────────────────────┘
            │                      │
            │   HTTP REST APIs     │
            │                      │
┌───────────▼──────────────────────▼───────────────────────┐
│         Time-Off Microservice (Node.js / NestJS)         │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ REST API Layer                                     │  │
│  │ - POST /api/requests (submit)                      │  │
│  │ - POST /api/requests/{id}/approve (manager)        │  │
│  │ - POST /api/requests/{id}/confirm (employee)       │  │
│  │ - GET /api/balances/{emp}/{loc} (get balance)      │  │
│  │ - GET /api/requests/{id} (get status)              │  │
│  └────────────────────────────────────────────────────┘  │
│                           │                              │
│  ┌────────────────────────▼───────────────────────────┐  │
│  │ Service Layer                                      │  │
│  │ - RequestService (lifecycle management)            │  │
│  │ - BalanceService (cache & sync)                    │  │
│  │ - HCMSyncService (HCM communication)               │  │
│  │ - DivergenceService (detection & reconciliation)   │  │
│  └────────────────────────────────────────────────────┘  │
│                           │                              │
│  ┌────────────────────────▼───────────────────────────┐  │
│  │ Data Layer                                         │  │
│  │ ┌──────────────────┐  ┌─────────────────────────┐  │  │
│  │ │ SQLite (Truth)   │  │ Redis Cache (Hot Data)  │  │  │
│  │ │ - Requests       │  │ - Current balances      │  │  │
│  │ │ - Balances       │  │ - Request status        │  │  │
│  │ │ - Audit logs     │  │ - TTL: 1 hour           │  │  │
│  │ └──────────────────┘  └─────────────────────────┘  │  │
│  └────────────────────────────────────────────────────┘  │
│                           │                              │
│  ┌────────────────────────▼───────────────────────────┐  │
│  │ Background Workers (RabbitMQ / Bull)               │  │
│  │ - Submit requests to HCM                           │  │
│  │ - Poll HCM for decisions (every 5 seconds)         │  │
│  │ - Daily balance sync (2 AM, batch API)             │  │
│  │ - Nightly stuck request recovery (24+ hrs)         │  │
│  └────────────────────────────────────────────────────┘  │
└─────────────────────────────┬────────────────────────────┘
                              │
                              │ HTTP/REST
                              │
                    ┌─────────▼─────────┐
                    │   HCM API         │
                    │ (Workday/SAP)     │
                    │                   │
                    │ - Real-time API   │
                    │ - Batch API       │
                    │ - Request status  │
                    └───────────────────┘
```

### Architectural Layers

#### 1. API Layer (REST)
- **Stateless**: Each request is independent
- **Fast**: Returns in <100ms (queues async work)
- **Validated**: Input validation before processing

#### 2. Service Layer (Business Logic)
- **RequestService**: Manages request lifecycle and state transitions
- **BalanceService**: Gets/validates/updates balances, manages cache
- **HCMSyncService**: Communicates with HCM (real-time and batch APIs)
- **DivergenceService**: Detects and reconciles balance divergences

#### 3. Data Layer (Persistence)
- **SQLite**: Local source of truth (requests, balances, audit logs)
- **Redis**: Hot cache for frequently accessed data
  - Stores current balances with 1-hour TTL
  - Eliminates database round-trip for repeated balance checks
  - At 1000 req/sec with 50k employees, estimated cache hit rate ~70-80%
  - Reduces SQLite load by ~70%, enabling faster queries for non-cached data
  - Enables geographic distribution (region-specific Redis instances for multi-region deployments)

#### 4. Worker Layer (Async Processing)
- **Queue**: RabbitMQ or Bull (in-process)
- **Workers**: Process HCM submissions, polling, syncs
- **Scheduler**: Nightly jobs for recovery and syncing

---

## 4. Data Model

### Core Entities

#### Balances Table (SQLite)
```sql
CREATE TABLE balances (
  id TEXT PRIMARY KEY,
  employee_id VARCHAR(100) NOT NULL,
  location_id VARCHAR(100) NOT NULL,
  balance_type VARCHAR(50) NOT NULL,
  current_balance DECIMAL(10,2) NOT NULL,
  hcm_version INT NOT NULL,
  last_synced_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE(employee_id, location_id, balance_type),
  INDEX idx_employee (employee_id),
  INDEX idx_location (location_id)
);
```

**Key Design**:
- `hcm_version`: Optimistic locking field. Incremented each update to detect concurrent modifications.
- `last_synced_at`: When we last validated with HCM (used to know staleness).

#### Requests Table (SQLite)
```sql
CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  employee_id VARCHAR(100) NOT NULL,
  location_id VARCHAR(100) NOT NULL,
  balance_type VARCHAR(50) NOT NULL,
  days_requested DECIMAL(10,2) NOT NULL,
  requested_balance_at_submission DECIMAL(10,2),
  status VARCHAR(50) NOT NULL,
  
  manager_id VARCHAR(100),
  manager_action_at TIMESTAMP,
  manager_reason TEXT,
  
  hcm_submission_id VARCHAR(100),
  submitted_to_hcm_at TIMESTAMP,
  hcm_approved_at TIMESTAMP,
  
  divergence_detected_at TIMESTAMP,
  divergence_reason TEXT,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_employee (employee_id),
  INDEX idx_status (status),
  INDEX idx_created (created_at)
);
```

**Key Design**:
- `status`: Tracks state (pending_manager_approval, processing, approved, rejected)
- `requested_balance_at_submission`: Used to detect if balance diverged during manager review
- `divergence_detected_at`: When we detected that HCM balance changed

#### Audit Logs Table (SQLite)
```sql
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  entity_type VARCHAR(50),
  entity_id TEXT,
  event_type VARCHAR(100),
  actor VARCHAR(50),
  details JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_entity (entity_type, entity_id),
  INDEX idx_event (event_type, created_at)
);
```

**Purpose**: Complete audit trail for compliance and debugging.

### Request State Machine

```
pending_manager_approval
  ├─ [Manager rejects] → rejected (TERMINAL)
  └─ [Manager approves] → processing
      ├─ [HCM approves] → approved (TERMINAL)
      └─ [HCM rejects OR divergence] → rejected (TERMINAL)
```

---

## 5. Request Lifecycle Workflows

### Workflow 1: Happy Path (No Divergence)

```
10:00 AM  Employee views balance: 20 days
10:05 AM  Employee submits request (5 days)
          System: Balance = 20, Stored: 20, Create request
          Response: "Submitted successfully"
          
10:10 AM  Manager approves
          System: Check balance = 20, matches submission ✓
          Status → processing
          Queue job: submit to HCM
          
10:11 AM  Worker submits to HCM
          HCM responds: {submissionId: HCM-789, status: received}
          
10:16 AM  Worker polls HCM
          HCM: "Approved"
          Deduct: 20 - 5 = 15
          Status → approved
```

### Workflow 2: Divergence During Manager Approval (Balance Increases)

```
10:00 AM  Employee sees 20, submits for 5 days
          System: requested_balance_at_submission = 20

10:30 AM  HCM updates: Work anniversary, balance = 25
          System: Doesn't know yet (will catch at next sync)

11:00 AM  Manager approves
          System: 
            1. Fetch current balance: 25
            2. Check: 25 != 20 (DIVERGENCE!)
            3. Is request valid? 25 >= 5? YES
            4. Set status: divergence_detected
            5. NOTIFY EMPLOYEE:
               "Your balance increased from 20 to 25 days.
                Do you want to proceed?"
          
11:01 AM  Employee confirms
          Status → processing
          Proceed with HCM submission
```

### Workflow 3: Divergence During Manager Approval (Balance Decreases)

```
10:00 AM  Employee sees 20, submits for 5 days

10:30 AM  HCM updates: Policy change, balance = 10

11:00 AM  Manager approves
          System:
            1. Fetch balance: 10
            2. Divergence detected: 10 != 20
            3. Is request valid? 10 >= 5? YES (barely)
            4. NOTIFY EMPLOYEE:
               "Your balance decreased to 10 days.
                You requested 5.
                Proceed or Cancel?"
          
11:01 AM  Employee chooses CANCEL
          Status → rejected
          NO deduction
```

### Workflow 4: Manager Rejects

```
10:05 AM  Employee submits
          Status → pending_manager_approval

10:10 AM  Manager rejects
          Status → rejected
          NO HCM submission
          NO balance change
```

### Workflow 5: Stuck Request Recovery

```
Day 1, 10 AM   Request submitted to HCM
               Worker starts polling every 5 seconds
               HCM: "Processing..."
               
Day 1, 11 AM   Worker still polling (60+ minutes)
               HCM: Still says "Processing..." or no response
               Worker: Gives up after exponential backoff timeout (~1 hour)
               Request stays in "processing" state in our DB
               Alert: Manager notified (optional, 1-hour timeout)
               
Day 2, 2 AM    Nightly recovery job runs
               Finds: Requests in "processing" >24 hours old
               Calls HCM: "Status of submission HCM-789?"
               HCM: Responds with "Approved" or "Rejected"
               Why HCM responds now:
                 - HCM had temporary outage, now recovered
                 - HCM finally finished the lengthy processing
                 - Request now has a definitive answer in HCM's logs
               Updates request, deducts/refunds balance
               Audit: Log recovery action
```

---

## 6. Balance Sync Strategy

### Real-Time API (Synchronous, On-Demand)
**When**: Employee submits or manager approves
**Cost**: ~10-20 HCM calls/second at peak
**Benefit**: Accurate for active requests
**Implementation**: Cache result 1 hour

### Batch API (Asynchronous, Scheduled)
**When**: Daily at 2 AM (off-peak, lowest load)
**Cost**: 1 HCM call for all employees (assumes bulk fetch)
**Benefit**: Catches independent HCM updates (work anniversaries, policy changes)
**Implementation**: 
- Fetch all balances
- Compare to local
- Auto-reconcile divergences
- Log all changes

**Assumptions**:
- Batch API returns all 50k+ employee balances in a single call without timeout
- If timeout risk exists: Implement clustered approach
  - Call batch API for 10k employees at a time
  - Retry failed clusters
  - Sequence clusters 5 minutes apart to avoid single timeout
  - Log cluster completion for recovery if job interrupted

### Polling (Asynchronous, Frequent)
**When**: Every 5 seconds
**Scope**: Requests in "processing" status
**Cost**: 200 HCM calls/sec at peak (1000 concurrent processing requests)
**Benefit**: Detects HCM decisions quickly
**Implementation**: Check status, update request, stop polling when terminal state

---

## 6A. Location-Based Considerations

### Multi-Location Employees
Employees can work at multiple locations (NYC, LA, Chicago, etc.). Each location has:
- Independent time-off balances (vacation, sick, personal days)
- Different policies and allocation rules
- Independent manager approval chains

**Example**:
```
Employee: John Smith
├─ NYC Location
│  ├─ Vacation: 20 days
│  ├─ Sick: 10 days
│  └─ Manager: Sarah (NYC)
└─ LA Location
   ├─ Vacation: 15 days
   ├─ Sick: 8 days
   └─ Manager: Mike (LA)
```

### Location-Based Manager Authorization
When a manager approves a request:
1. Request has location_id (where employee is requesting from)
2. Manager has location_id (manager's office)
3. **Validation**: Request.locationId must equal Manager.locationId
4. If mismatch: Reject with UnauthorizedError
   - Manager Sarah from NYC cannot approve John's LA request
   - Mike from LA must approve LA requests

### Location-Independent Request Lifecycle
- Each request is tied to ONE location
- Approval at NYC doesn't affect LA balances
- HCM submission specifies location explicitly
- Concurrent requests from different locations don't interfere

**Example workflow:**
```
John at NYC submits: 5 days vacation (NYC balance: 20)
John at LA submits: 3 days vacation (LA balance: 15)
Manager Sarah (NYC) approves NYC request
Manager Mike (LA) approves LA request
Result:
  - NYC balance: 20 → 15 (after NYC approval + HCM processing)
  - LA balance: 15 → 12 (after LA approval + HCM processing)
```

### Location-Aware Batch Sync
During daily batch sync at 2 AM:
- HCM returns balances for ALL employees at ALL locations
- System processes per-location:
  - If NYC sync succeeds: Update NYC balances, set last_synced_at
  - If LA sync times out: LA balances stay stale
  - **Do NOT** treat one location's failure as full sync failure
- Retry failed locations independently on next sync cycle
- Each location tracks its own last_synced_at timestamp

**Example:**
```
Batch sync attempts 50k employees across 10 locations:
- NYC: Success (10k employees, 5 seconds)
- LA: Success (8k employees, 4 seconds)
- Chicago: Timeout after 2 seconds
- Denver: Success (7k employees, 3 seconds)
- ...

Result:
- NYC, LA, Denver, etc: Updated ✓
- Chicago: Stays stale, retry next cycle ✓
- System continues serving requests normally
```

### Employee Transfers (Out of Scope)
When an employee transfers from NYC to LA:
- NYC balance record remains (historical)
- LA creates new balance record
- System does NOT auto-migrate or merge balances
- Employee now has two location records in system
- HCM determines which location is "active"
- Any balance transfer logic is HCM's responsibility

### Divergence Detection Per Location
Each location has independent divergence detection:
```
NYC Location:
  Submitted: 20 days
  Current: 25 days (work anniversary)
  Divergence: YES (increase, auto-approve)

LA Location:
  Submitted: 15 days
  Current: 15 days
  Divergence: NO (proceed normally)
```

---

## 7. System Assumptions

We make the following assumptions about the HCM system, ExampleHR, and deployment environment:

### HCM Capabilities
1. **HCM has REST APIs only** (no webhooks, no message queues)
   - We cannot rely on push notifications for balance updates
   - We must use polling and batch sync to stay synchronized
   - API latency: 200-300ms per call is acceptable

2. **Batch API returns all employee balances in a single bulk call**
   - No pagination required (or handled by HCM transparently)
   - Single call completes within 5-10 seconds for 50k+ employees
   - If timeout risk exists: Implement clustering approach (call in 10k-employee batches)

3. **HCM can handle 200-300 concurrent requests during peak hours**
   - Real-time API calls (employee submissions, manager approvals): 10-20 req/sec
   - Polling calls (stuck requests): 200 req/sec at peak (1000 concurrent requests)
   - Total peak: ~220 req/sec, within HCM capacity

4. **HCM processes requests asynchronously**
   - Submission returns immediately with a submission ID, not a final decision
   - Decision comes 5 seconds to 1 hour later (HCM's queue)
   - We must poll to discover the outcome

### ExampleHR Behavior
5. **Manager approval takes 5 minutes to 1 hour**
   - Unlikely that balance will diverge instantly during approval
   - Divergence detection during approval is a safety measure, not the common case

6. **Employees do not edit requests after submission**
   - Out of scope per problem statement
   - Simplifies request lifecycle (no versioning needed)

### System Constraints
7. **Daily batch sync completes by 6 AM**
   - Runs at 2 AM (lowest load)
   - Completes within 4 hours even for edge cases
   - Clustering approach (if timeout risk): Complete within 2 hours (10 clusters × ~10 min each)

8. **Polling timeout for stuck requests is ~1 hour**
   - Worker polls every 5 seconds for up to 1 hour
   - After 1 hour: Request flagged, worker stops polling, stays in "processing" state
   - Nightly job (24+ hours later) makes final check

9. **No partial approvals or cascading updates**
   - One request = one decision from HCM
   - Balance deduction happens atomically (all-or-nothing)

10. **Network is generally reliable**
    - Temporary HCM outages occur but recover within hours
    - Persistent network issues are rare (monitored separately)

### Location-Based Considerations
11. **Balances are strictly per-employee-per-location**
    - Employee "John" at NYC location has 20 vacation days
    - Same employee "John" at LA location has 15 vacation days
    - Balances are independent (no pooling across locations)
    - Request from NYC doesn't affect LA balance

12. **Each location has independent manager hierarchy**
    - NYC manager can only approve requests for NYC location
    - LA manager can only approve requests for LA location
    - System validates: requestLocation matches managerLocation
    - Manager from wrong location receives: UnauthorizedError

13. **HCM provides per-location balances with location dimension**
    - Batch API includes location in response: {employee_id, location_id, balance_type, balance, hcm_version}
    - Real-time API requires location_id parameter
    - Each location has independent hcm_version for optimistic locking

14. **Batch sync failures are location-aware**
    - If NYC batch times out, LA batch can still succeed
    - Partial sync: NYC stays stale, LA is current
    - Retry logic retries failed locations independently
    - Do not treat single location failure as full sync failure

15. **Employee transfers between locations are out of scope**
    - When employee transfers from NYC to LA:
      - NYC balances remain in system (historical record)
      - LA creates new balance record
      - System does not auto-transfer or merge balances
      - This is handled by HCM, we follow HCM's data
    - Any cross-location balance management is HCM responsibility

16. **Multi-location employees see all their balances**
    - Employee with locations: NYC, LA, Chicago
    - Single API call should return balances for all 3 locations
    - Response format: {locations: [{locationId, balances: {...}}, ...]}
    - Each location can have different balance types based on policy

---

## 8. API Specification

### Core Endpoints

#### Submit Request
```
POST /api/requests
Body: {employeeId, locationId, balanceType, daysRequested, dates}
Response: {requestId, status, currentBalance}
```

#### Manager Approves
```
POST /api/requests/{requestId}/approve
Body: {managerId, managerLocationId}
Response: {requestId, status} or {status: pending_employee_confirmation, divergence: {...}}

Location Validation:
1. Fetch request: Get location_id from request
2. Fetch manager: Get location_id from manager profile
3. Verify: request.location_id == manager.location_id
4. If mismatch: Reject with UnauthorizedError
   "Manager from {managerLocation} cannot approve requests for {requestLocation}"
```

#### Employee Confirms (After Divergence)
```
POST /api/requests/{requestId}/confirm
Body: {employeeId, action: "proceed" | "cancel"}
Response: {requestId, status}
```

#### Get Balance (Single Location)
```
GET /api/balances/{employeeId}/{locationId}

Process:
1. Check Redis cache (1-hour TTL)
2. If cache miss: Query SQLite
3. Call HCM real-time API to verify freshness
4. If divergence detected: Log, reconcile, update cache/DB
5. Return: {balances: {vacation: 20, sick: 10, ...}, lastSynced: "...", source: "hcm"}

Response: {balances: {vacation: 20, sick: 10, ...}, lastSynced: "...", source: "hcm"}
```

#### Get All Balances (All Locations for Employee)
```
GET /api/balances/{employeeId}

Process:
1. Query SQLite for all locations for this employee
2. For each location:
   - Check Redis cache
   - If cache miss: Query SQLite
   - Call HCM real-time API to verify
   - Reconcile divergences
3. Combine all locations into single response

Response: {
  employeeId: "E1",
  locations: [
    {
      locationId: "NYC",
      balances: {vacation: 20, sick: 10, personal: 5},
      lastSynced: "2026-04-17T14:00:00Z",
      source: "hcm"
    },
    {
      locationId: "LA",
      balances: {vacation: 15, sick: 8, personal: 3},
      lastSynced: "2026-04-17T14:02:00Z",
      source: "hcm"
    }
  ]
}
```

#### Get Request Status
```
GET /api/requests/{requestId}
Response: {requestId, status, daysRequested, approvedAt, balanceRemaining}
```

---

## 9. Non-Functional Requirements

- **Availability**: 99.5% uptime
- **API Latency**: <100ms (sync), HCM calls timeout 5 seconds
- **Polling Interval**: 5 seconds
- **Code Coverage**: 80% minimum, 85%+ for service logic
- **Data Consistency**: ACID, no lost updates
- **Scale**: 50k+ employees, 1000 requests/second
- **Database**: SQLite (dev), PostgreSQL (production recommended)

---

## 10. Future Considerations

**Out of Scope for v1** (but valid):
- Request cancellation by employee
- Request editing by employee
- Partial approval by manager
- Message queues or Webhook support (if HCM adds it)
- Bulk import of balances

---

**End of Document**