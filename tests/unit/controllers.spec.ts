import { RequestsController } from '../../src/controllers/requests.controller';
import { BalancesController } from '../../src/controllers/balances.controller';
import { HealthController } from '../../src/controllers/health.controller';

// ─── Mock factories ───────────────────────────────────────────────────────────

function mockRequestService() {
  return {
    submitRequest: jest.fn(),
    approveRequest: jest.fn(),
    confirmRequest: jest.fn(),
    getRequestStatus: jest.fn(),
  };
}

function mockBalanceService() {
  return {
    getBalance: jest.fn(),
    detectDivergence: jest.fn(),
    getAllBalancesForEmployee: jest.fn(),
  };
}

function mockHCMSyncService() {
  return {
    fetchBalance: jest.fn(),
    healthCheck: jest.fn(),
  };
}

function mockRedisCacheService() {
  return {
    healthCheck: jest.fn(),
  };
}

function mockDatabaseConnection() {
  return {
    isInitialized: jest.fn(),
  };
}

// ─── RequestsController ───────────────────────────────────────────────────────

describe('RequestsController', () => {
  let controller: RequestsController;
  let requestService: ReturnType<typeof mockRequestService>;

  beforeEach(() => {
    requestService = mockRequestService();
    controller = new RequestsController(requestService as any);
  });

  describe('submitRequest', () => {
    it('should submit a request and return id, status, and balance', async () => {
      requestService.submitRequest.mockResolvedValue({
        id: 'REQ-001',
        status: 'pending',
        requestedBalanceAtSubmission: 15,
      });

      const result = await controller.submitRequest({
        employeeId: 'E001',
        locationId: 'L001',
        balanceType: 'vacation',
        daysRequested: 3,
        dates: { startDate: new Date('2026-05-01'), endDate: new Date('2026-05-03') },
      });

      expect(requestService.submitRequest).toHaveBeenCalledWith({
        employeeId: 'E001',
        locationId: 'L001',
        balanceType: 'vacation',
        daysRequested: 3,
      });
      expect(result).toEqual({
        requestId: 'REQ-001',
        status: 'pending',
        currentBalance: 15,
      });
    });

    it('should propagate service errors', async () => {
      requestService.submitRequest.mockRejectedValue(new Error('Insufficient balance'));
      await expect(
        controller.submitRequest({
          employeeId: 'E001',
          locationId: 'L001',
          balanceType: 'vacation',
          daysRequested: 99,
          dates: { startDate: new Date('2026-05-01'), endDate: new Date('2026-08-07') },
        }),
      ).rejects.toThrow('Insufficient balance');
    });
  });

  describe('approveRequest', () => {
    it('should approve a request and return id and status', async () => {
      requestService.approveRequest.mockResolvedValue({
        id: 'REQ-001',
        status: 'approved',
      });

      const result = await controller.approveRequest('REQ-001', {
        managerId: 'M001',
        managerLocationId: 'L001',
      });

      expect(requestService.approveRequest).toHaveBeenCalledWith('REQ-001', 'M001', 'L001');
      expect(result).toEqual({ requestId: 'REQ-001', status: 'approved' });
      expect(result).not.toHaveProperty('divergence');
    });

    it('should return divergence info when status is pending_employee_confirmation', async () => {
      requestService.approveRequest.mockResolvedValue({
        id: 'REQ-002',
        status: 'pending_employee_confirmation',
        divergenceReason: 'Balance changed since submission',
      });

      const result = await controller.approveRequest('REQ-002', {
        managerId: 'M001',
        managerLocationId: 'L001',
      });

      expect(result).toEqual({
        requestId: 'REQ-002',
        status: 'pending_employee_confirmation',
        divergence: { detected: true, reason: 'Balance changed since submission' },
      });
    });

    it('should propagate service errors', async () => {
      requestService.approveRequest.mockRejectedValue(new Error('Request not found'));
      await expect(
        controller.approveRequest('INVALID', { managerId: 'M001', managerLocationId: 'L001' }),
      ).rejects.toThrow('Request not found');
    });
  });

  describe('confirmRequest', () => {
    it('should confirm a request with proceed action', async () => {
      requestService.confirmRequest.mockResolvedValue({
        id: 'REQ-002',
        status: 'approved',
      });

      const result = await controller.confirmRequest('REQ-002', { action: 'proceed' });

      expect(requestService.confirmRequest).toHaveBeenCalledWith('REQ-002', 'E001', 'proceed');
      expect(result).toEqual({ requestId: 'REQ-002', status: 'approved' });
    });

    it('should confirm a request with cancel action', async () => {
      requestService.confirmRequest.mockResolvedValue({
        id: 'REQ-002',
        status: 'cancelled',
      });

      const result = await controller.confirmRequest('REQ-002', { action: 'cancel' });

      expect(requestService.confirmRequest).toHaveBeenCalledWith('REQ-002', 'E001', 'cancel');
      expect(result).toEqual({ requestId: 'REQ-002', status: 'cancelled' });
    });
  });

  describe('getRequestStatus', () => {
    it('should return full request details without divergence', async () => {
      const now = new Date();
      requestService.getRequestStatus.mockResolvedValue({
        id: 'REQ-001',
        status: 'approved',
        employeeId: 'E001',
        locationId: 'L001',
        balanceType: 'vacation',
        daysRequested: 3,
        createdAt: now,
        updatedAt: now,
        hcmApprovedAt: now,
        divergenceDetectedAt: null,
        divergenceReason: null,
      });

      const result = await controller.getRequestStatus('REQ-001');

      expect(result).toEqual({
        requestId: 'REQ-001',
        status: 'approved',
        employeeId: 'E001',
        locationId: 'L001',
        balanceType: 'vacation',
        daysRequested: 3,
        createdAt: now,
        updatedAt: now,
        approvedAt: now,
        divergence: undefined,
      });
    });

    it('should include divergence info when divergence was detected', async () => {
      const now = new Date();
      requestService.getRequestStatus.mockResolvedValue({
        id: 'REQ-003',
        status: 'pending_employee_confirmation',
        employeeId: 'E001',
        locationId: 'L001',
        balanceType: 'vacation',
        daysRequested: 5,
        createdAt: now,
        updatedAt: now,
        hcmApprovedAt: null,
        divergenceDetectedAt: now,
        divergenceReason: 'HCM balance differs',
      });

      const result = await controller.getRequestStatus('REQ-003');

      expect(result.divergence).toEqual({ detected: true, reason: 'HCM balance differs' });
    });

    it('should propagate errors for unknown requests', async () => {
      requestService.getRequestStatus.mockRejectedValue(new Error('Not found'));
      await expect(controller.getRequestStatus('NOPE')).rejects.toThrow('Not found');
    });
  });
});

// ─── BalancesController ───────────────────────────────────────────────────────

describe('BalancesController', () => {
  let controller: BalancesController;
  let balanceService: ReturnType<typeof mockBalanceService>;
  let hcmSyncService: ReturnType<typeof mockHCMSyncService>;

  beforeEach(() => {
    balanceService = mockBalanceService();
    hcmSyncService = mockHCMSyncService();
    controller = new BalancesController(balanceService as any, hcmSyncService as any);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getBalance', () => {
    const cachedBalance = {
      currentBalance: 12,
      lastSyncedAt: new Date('2026-04-19T00:00:00Z'),
    };

    it('should return HCM balance when HCM fetch succeeds and no divergence', async () => {
      balanceService.getBalance.mockResolvedValue(cachedBalance);
      hcmSyncService.fetchBalance.mockResolvedValue({ vacation: 12 });
      balanceService.detectDivergence.mockResolvedValue({ detected: false });

      const result = await controller.getBalance('E001', 'L001');

      expect(balanceService.getBalance).toHaveBeenCalledWith('E001', 'L001', 'vacation');
      expect(hcmSyncService.fetchBalance).toHaveBeenCalledWith('E001', 'L001');
      expect(result.source).toBe('hcm');
      expect(result.balances.vacation).toBe(12);
      expect(result.employeeId).toBe('E001');
      expect(result.locationId).toBe('L001');
    });

    it('should log divergence when HCM and cache balances differ', async () => {
      balanceService.getBalance.mockResolvedValue(cachedBalance);
      hcmSyncService.fetchBalance.mockResolvedValue({ vacation: 10 });
      balanceService.detectDivergence.mockResolvedValue({
        detected: true,
        reason: 'Balance mismatch: local=12, hcm=10',
      });

      const result = await controller.getBalance('E001', 'L001');

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Divergence detected for E001@L001'),
      );
      expect(result.source).toBe('hcm');
      expect(result.balances.vacation).toBe(10);
    });

    it('should return stale source when HCM fetch fails', async () => {
      balanceService.getBalance.mockResolvedValue(cachedBalance);
      hcmSyncService.fetchBalance.mockRejectedValue(new Error('HCM timeout'));

      const result = await controller.getBalance('E001', 'L001');

      expect(result.source).toBe('stale');
      expect(result.balances.vacation).toBe(12);
      expect(console.warn).toHaveBeenCalled();
    });

    it('should use cached balance when HCM returns null', async () => {
      balanceService.getBalance.mockResolvedValue(cachedBalance);
      hcmSyncService.fetchBalance.mockResolvedValue(null);

      const result = await controller.getBalance('E001', 'L001');

      expect(result.source).toBe('cache');
      expect(result.balances.vacation).toBe(12);
      expect(balanceService.detectDivergence).not.toHaveBeenCalled();
    });

    it('should always include sick and personal balances', async () => {
      balanceService.getBalance.mockResolvedValue(cachedBalance);
      hcmSyncService.fetchBalance.mockResolvedValue({ vacation: 12 });
      balanceService.detectDivergence.mockResolvedValue({ detected: false });

      const result = await controller.getBalance('E001', 'L001');

      expect(result.balances.sick).toBe(10);
      expect(result.balances.personal).toBe(5);
    });
  });

  describe('getAllBalances', () => {
    it('should aggregate balances by location and enrich with HCM data', async () => {
      const syncDate = new Date('2026-04-19T00:00:00Z');
      balanceService.getAllBalancesForEmployee.mockResolvedValue([
        { locationId: 'L001', balanceType: 'vacation', currentBalance: 10, lastSyncedAt: syncDate },
        { locationId: 'L001', balanceType: 'sick', currentBalance: 5, lastSyncedAt: syncDate },
        { locationId: 'L002', balanceType: 'vacation', currentBalance: 8, lastSyncedAt: syncDate },
      ]);
      hcmSyncService.fetchBalance
        .mockResolvedValueOnce({ vacation: 10, sick: 5 })
        .mockResolvedValueOnce({ vacation: 9 });

      const result = await controller.getAllBalances('E001');

      expect(result.employeeId).toBe('E001');
      expect(result.locations).toHaveLength(2);

      const loc1 = result.locations.find((l: any) => l.locationId === 'L001');
      expect(loc1.source).toBe('hcm');
      expect(loc1.balances).toEqual({ vacation: 10, sick: 5 });

      const loc2 = result.locations.find((l: any) => l.locationId === 'L002');
      expect(loc2.source).toBe('hcm');
      expect(loc2.balances).toEqual({ vacation: 9 });
    });

    it('should mark location as stale when HCM fetch fails for that location', async () => {
      balanceService.getAllBalancesForEmployee.mockResolvedValue([
        { locationId: 'L001', balanceType: 'vacation', currentBalance: 10, lastSyncedAt: new Date() },
        { locationId: 'L002', balanceType: 'vacation', currentBalance: 8, lastSyncedAt: new Date() },
      ]);
      hcmSyncService.fetchBalance
        .mockResolvedValueOnce({ vacation: 10 })
        .mockRejectedValueOnce(new Error('HCM down'));

      const result = await controller.getAllBalances('E001');

      const loc1 = result.locations.find((l: any) => l.locationId === 'L001');
      expect(loc1.source).toBe('hcm');

      const loc2 = result.locations.find((l: any) => l.locationId === 'L002');
      expect(loc2.source).toBe('stale');
      expect(loc2.balances.vacation).toBe(8);
    });

    it('should return empty locations for employee with no balances', async () => {
      balanceService.getAllBalancesForEmployee.mockResolvedValue([]);

      const result = await controller.getAllBalances('E999');

      expect(result).toEqual({ employeeId: 'E999', locations: [] });
    });

    it('should keep cached balances when HCM returns null', async () => {
      balanceService.getAllBalancesForEmployee.mockResolvedValue([
        { locationId: 'L001', balanceType: 'vacation', currentBalance: 10, lastSyncedAt: new Date() },
      ]);
      hcmSyncService.fetchBalance.mockResolvedValue(null);

      const result = await controller.getAllBalances('E001');

      const loc = result.locations[0];
      expect(loc.source).toBe('cache');
      expect(loc.balances.vacation).toBe(10);
    });
  });
});

// ─── HealthController ─────────────────────────────────────────────────────────

describe('HealthController', () => {
  let controller: HealthController;
  let hcmSyncService: ReturnType<typeof mockHCMSyncService>;
  let redisCacheService: ReturnType<typeof mockRedisCacheService>;
  let db: ReturnType<typeof mockDatabaseConnection>;

  beforeEach(() => {
    hcmSyncService = mockHCMSyncService();
    redisCacheService = mockRedisCacheService();
    db = mockDatabaseConnection();
    controller = new HealthController(hcmSyncService as any, redisCacheService as any, db as any);
  });

  describe('getHealth', () => {
    it('should return healthy when all services are up', async () => {
      db.isInitialized.mockReturnValue(true);
      hcmSyncService.healthCheck.mockResolvedValue(true);
      redisCacheService.healthCheck.mockResolvedValue(true);

      const result = await controller.getHealth();

      expect(result.status).toBe('healthy');
      expect(result.services).toEqual({ database: 'up', hcm: 'up', redis: 'up' });
      expect(result.timestamp).toBeDefined();
    });

    it('should return degraded when database is down', async () => {
      db.isInitialized.mockReturnValue(false);
      hcmSyncService.healthCheck.mockResolvedValue(true);
      redisCacheService.healthCheck.mockResolvedValue(true);

      const result = await controller.getHealth();

      expect(result.status).toBe('degraded');
      expect(result.services!.database).toBe('down');
      expect(result.services!.hcm).toBe('up');
    });

    it('should return degraded when HCM is down', async () => {
      db.isInitialized.mockReturnValue(true);
      hcmSyncService.healthCheck.mockResolvedValue(false);
      redisCacheService.healthCheck.mockResolvedValue(true);

      const result = await controller.getHealth();

      expect(result.status).toBe('degraded');
      expect(result.services!.hcm).toBe('down');
    });

    it('should return degraded when redis is down but db and hcm are up', async () => {
      db.isInitialized.mockReturnValue(true);
      hcmSyncService.healthCheck.mockResolvedValue(true);
      redisCacheService.healthCheck.mockResolvedValue(false);

      const result = await controller.getHealth();

      // status is based on db && hcm only, so still healthy
      expect(result.status).toBe('healthy');
      expect(result.services!.redis).toBe('down');
    });

    it('should return unhealthy when a service check throws', async () => {
      db.isInitialized.mockImplementation(() => {
        throw new Error('DB crashed');
      });

      const result = await controller.getHealth();

      expect(result.status).toBe('unhealthy');
      expect(result.error).toBe('DB crashed');
    });

    it('should return unhealthy with generic message for non-Error throws', async () => {
      db.isInitialized.mockImplementation(() => {
        throw 'something weird';
      });

      const result = await controller.getHealth();

      expect(result.status).toBe('unhealthy');
      expect(result.error).toBe('Unknown error');
    });
  });

  describe('getReady', () => {
    it('should return ready when db and hcm are healthy', async () => {
      db.isInitialized.mockReturnValue(true);
      hcmSyncService.healthCheck.mockResolvedValue(true);

      const result = await controller.getReady();

      expect(result).toEqual({ status: 'ready' });
    });

    it('should throw when database is not initialized', async () => {
      db.isInitialized.mockReturnValue(false);
      hcmSyncService.healthCheck.mockResolvedValue(true);

      await expect(controller.getReady()).rejects.toThrow('Service not ready');
    });

    it('should throw when HCM health check fails', async () => {
      db.isInitialized.mockReturnValue(true);
      hcmSyncService.healthCheck.mockResolvedValue(false);

      await expect(controller.getReady()).rejects.toThrow('Service not ready');
    });

    it('should propagate errors from health check calls', async () => {
      db.isInitialized.mockReturnValue(true);
      hcmSyncService.healthCheck.mockRejectedValue(new Error('Network error'));

      await expect(controller.getReady()).rejects.toThrow('Network error');
    });
  });

  describe('getLive', () => {
    it('should return alive status with a timestamp', () => {
      const result = controller.getLive();

      expect(result.status).toBe('alive');
      expect(result.timestamp).toBeDefined();
      // Verify timestamp is a valid ISO string
      expect(() => new Date(result.timestamp)).not.toThrow();
    });
  });
});
