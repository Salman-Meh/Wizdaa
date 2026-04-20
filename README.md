# Time-Off Microservice

A robust backend microservice for managing time-off request lifecycles while maintaining balance integrity between ExampleHR (frontend) and HCM (Human Capital Management system).

## Quick Start

### Prerequisites
- Node.js 16+ 
- npm or yarn
- Redis (optional — app works without it, caching disabled)

### Installation

```bash
# Install dependencies
npm install

# Setup environment
cp .env.example .env

# Build TypeScript
npm run build
```

### Running the Application

```bash
# Development mode
npm run dev

# Production mode
npm run start

# Run mock HCM server (separate terminal)
npm run dev:mock-hcm
```

### Running Tests

```bash
# All tests
npm test

# Unit tests only
npm run test:unit

# Integration tests
npm run test:integration

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage
```

## Architecture

### System Overview
```
ExampleHR Frontend
    ↓↑ (REST APIs)
Time-Off Microservice
    ├─ API Layer (Request/Response handling)
    ├─ Service Layer (Business logic)
    │  ├─ BalanceService (balance operations)
    │  ├─ RequestService (lifecycle management)
    │  ├─ HCMSyncService (HCM communication)
    │  └─ DivergenceService (divergence detection)
    ├─ Data Layer (SQLite + Redis cache + audit logs)
    └─ Worker Layer (async processing)
    ↓↑ (HTTP REST)
HCM API (Workday/SAP)
```

### Key Features

1. **Balance Management**
   - Per-employee-per-location balance tracking
   - Optimistic locking to prevent race conditions
   - Divergence detection with auto-reconciliation

2. **Request Lifecycle**
   - Submit → Manager Approval → HCM Processing → Complete
   - Handles divergence during manager approval
   - Automatic recovery of stuck requests

3. **Multi-Location Support**
   - Independent balance tracking per location
   - Location-aware manager authorization
   - Location-specific sync handling

4. **Reliability**
   - 99.5% availability target
   - <100ms API latency
   - Dual validation (local + HCM)
   - Comprehensive audit trail

## Database Schema

### Tables
- **balances**: Employee balances by location with optimistic locking
- **requests**: Time-off request lifecycle tracking
- **audit_logs**: Complete audit trail for compliance
- **locations**: Supported office locations
- **employees**: Employee metadata
- **managers**: Manager-employee relationships

See `src/database/migrations/` for the full schema.

## Services

### BalanceService
- `getBalance()` - Fetch balance (local + HCM verification)
- `deductBalance()` - Deduct with optimistic locking
- `batchUpdateBalances()` - Batch sync from HCM
- `detectDivergence()` - Detect balance changes
- `getAllBalancesForEmployee()` - Multi-location visibility

### RequestService
- `submitRequest()` - Submit time-off request
- `approveRequest()` - Manager approval (with location validation)
- `confirmRequest()` - Employee confirmation after divergence
- `getRequestStatus()` - Get request details
- `getRequestsInProcessing()` - For polling workers

### HCMSyncService
- `fetchBalance()` - Real-time balance from HCM
- `batchSync()` - Daily batch sync (location-aware)
- `submitRequest()` - Submit to HCM for processing
- `pollStatus()` - Poll for HCM decision

### DivergenceService
- `detectDivergence()` - Detect local vs HCM mismatch
- `canAutoReconcile()` - Determine if auto-resolvable
- `logDivergence()` - Audit divergence events

## API Endpoints

### Submit Request
```
POST /api/requests
{
  "employeeId": "E001",
  "locationId": "NYC",
  "balanceType": "vacation",
  "daysRequested": 5
}
```

### Manager Approval
```
POST /api/requests/{requestId}/approve
{
  "managerId": "M001",
  "managerLocationId": "NYC"
}
```

### Employee Confirmation
```
POST /api/requests/{requestId}/confirm
{
  "action": "proceed" | "cancel"
}
```

### Get Balance
```
GET /api/balances/{employeeId}/{locationId}
GET /api/balances/{employeeId}  (all locations)
```

### Get Request Status
```
GET /api/requests/{requestId}
```

## Configuration

See `.env.example` for all available options:

```bash
# Application
NODE_ENV=development
PORT=3000
LOG_LEVEL=debug

# HCM API
HCM_API_URL=http://localhost:3001
HCM_API_TIMEOUT_MS=5000
HCM_RETRY_ATTEMPTS=3

# Database
DB_PATH=./data/timeoff.db

# Redis (optional — app degrades gracefully without it)
REDIS_URL=redis://localhost:6379
REDIS_CACHE_TTL_SECONDS=3600

# Sync
BATCH_SYNC_INTERVAL_MS=3600000
POLLING_INTERVAL_MS=5000
STUCK_REQUEST_TIMEOUT_MS=3600000
```

## Testing

### Test Structure
```
tests/
├── fixtures/
│   ├── mock-hcm.ts          (Mock HCM server)
│   └── setup.ts             (Test environment setup)
├── integration/
│   ├── happy-path.spec.ts
│   ├── divergence.spec.ts
│   ├── multi-location.spec.ts
│   └── ...
```

### Test Coverage Targets
- **Overall**: 85% minimum
- **Service Logic**: 95% minimum
- **Integration**: 90% minimum

### Running Specific Tests
```bash
# Single test file
npm test -- balance.service.spec.ts

# Test pattern
npm test -- --testNamePattern="divergence"

# Watch mode for development
npm run test:watch
```

## Development Workflow

1. **Write Tests First** (TDD approach)
   - Add test cases to `*.spec.ts` files
   - Tests specify expected behavior

2. **Implement Service**
   - Write implementation to pass tests
   - Ensure 95%+ code coverage

3. **Add Integration Tests**
   - Test service interactions
   - Verify complete workflows

4. **Run Full Test Suite**
   ```bash
   npm run test:coverage
   ```

## Deployment

### Production Checklist
- [ ] Set `NODE_ENV=production`
- [ ] Configure real HCM_API_URL
- [ ] Set up PostgreSQL (recommended for scale)
- [ ] Configure Redis cache (recommended for production)
- [ ] Setup monitoring/logging
- [ ] Configure database backups
- [ ] Set up CI/CD pipeline

### Docker Deployment
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist ./dist
CMD ["node", "dist/main.js"]
```

## Monitoring & Observability

### Key Metrics
- API latency (target: <100ms)
- HCM API response time
- Divergence rate
- Request completion rate
- Batch sync failures

### Audit Trail
All operations logged to `audit_logs` table:
- Balance changes
- Request state transitions
- Divergence events
- HCM communications

## Troubleshooting

### Common Issues

**HCM connection failed**
- Check HCM_API_URL in .env
- Verify mock server is running: `npm run dev:mock-hcm`
- Check network connectivity

**Database locked**
- Ensure no other instances are running
- Check for long-running transactions
- Delete corrupted .db file and restart

**High divergence rate**
- Check HCM API for issues
- Verify batch sync is running
- Review audit_logs for patterns

**Redis not connecting**
- Verify Redis is running: `redis-cli ping` should return `PONG`
- Check `REDIS_URL` in `.env` (default: `redis://localhost:6379`)
- The app works without Redis — balance caching will be disabled and all reads go to SQLite

## Contributing

1. Write tests first (TDD)
2. Ensure 95%+ code coverage
3. Run full test suite: `npm run test:coverage`
4. Follow existing code style
5. Update documentation

## License

MIT

## Support

For issues and questions, check:
- Technical Requirements Document (TRD.md)
- Test Suite Specification (TEST_SUITE.md)
- Service code comments
- Audit logs for debugging
