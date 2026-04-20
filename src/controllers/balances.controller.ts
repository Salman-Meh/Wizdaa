/**
 * Balances Controller
 * Handles balance query endpoints
 */

import { Controller, Get, Param } from '@nestjs/common';
import { BalanceService } from '../services/balance.service';
import { HCMSyncService } from '../services/hcm-sync.service';

@Controller('api/balances')
export class BalancesController {
  constructor(
    private balanceService: BalanceService,
    private hcmSyncService: HCMSyncService
  ) {}

  /**
   * Get balance for single location
   * GET /api/balances/{employeeId}/{locationId}
   */
  @Get(':employeeId/:locationId')
  async getBalance(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string
  ) {
    // Get local balance
    const balance = await this.balanceService.getBalance(employeeId, locationId, 'vacation');

    // Try to fetch from HCM for verification (real-time freshness check)
    let hcmBalance: Record<string, number> | null = null;
    let source = 'cache';

    try {
      hcmBalance = await this.hcmSyncService.fetchBalance(employeeId, locationId);
      if (hcmBalance) {
        source = 'hcm';
        // Check for divergence
        const divergence = await this.balanceService.detectDivergence(
          balance.currentBalance,
          hcmBalance.vacation,
          0 // No specific request being checked
        );

        if (divergence.detected) {
          // Log divergence but use HCM value
          console.log(`Divergence detected for ${employeeId}@${locationId}: ${divergence.reason}`);
        }
      }
    } catch (error) {
      // HCM unavailable, use local cache
      console.warn(`HCM fetch failed for ${employeeId}@${locationId}:`, error);
      source = 'stale';
    }

    return {
      employeeId,
      locationId,
      balances: {
        vacation: hcmBalance?.vacation || balance.currentBalance,
        sick: 10, // TODO: Query actual values
        personal: 5 // TODO: Query actual values
      },
      lastSynced: balance.lastSyncedAt || new Date(),
      source
    };
  }

  /**
   * Get all balances for all locations
   * GET /api/balances/{employeeId}
   */
  @Get(':employeeId')
  async getAllBalances(@Param('employeeId') employeeId: string) {
    // Get all local balances for this employee
    const allBalances = await this.balanceService.getAllBalancesForEmployee(employeeId);

    // Group by location
    const locationMap = new Map<string, any>();

    for (const balance of allBalances) {
      if (!locationMap.has(balance.locationId)) {
        locationMap.set(balance.locationId, {
          locationId: balance.locationId,
          balances: {},
          lastSynced: balance.lastSyncedAt || new Date(),
          source: 'cache'
        });
      }

      const locData = locationMap.get(balance.locationId)!;
      locData.balances[balance.balanceType] = balance.currentBalance;
    }

    // Try to fetch fresh data from HCM for each location
    const locations = Array.from(locationMap.values());
    for (const loc of locations) {
      try {
        const hcmData = await this.hcmSyncService.fetchBalance(employeeId, loc.locationId);
        if (hcmData) {
          loc.balances = hcmData;
          loc.source = 'hcm';
          loc.lastSynced = new Date();
        }
      } catch (error) {
        console.warn(
          `HCM fetch failed for ${employeeId}@${loc.locationId}:`,
          error
        );
        loc.source = 'stale';
      }
    }

    return {
      employeeId,
      locations
    };
  }
}
