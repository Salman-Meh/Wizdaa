/**
 * HCMSyncService
 * Handles all communication with HCM:
 * - Real-time balance fetching
 * - Batch sync operations
 * - Request submission
 * - Status polling
 */

import * as http from 'http';
import Database from 'better-sqlite3';
import { BalanceType } from '../models/types';
import { BalanceService } from './balance.service';

interface HCMBalance {
  employeeId: string;
  locationId: string;
  balanceType: BalanceType;
  balance: number;
  hcmVersion: number;
  lastUpdatedAt: string;
}

interface HCMSubmissionResponse {
  submissionId: string;
  status: 'received' | 'processing' | 'approved' | 'rejected';
  createdAt: string;
}

export class HCMSyncService {
  private hcmUrl: string;
  private timeout: number;
  private retryAttempts: number;
  private retryDelayMs: number;

  constructor(
    private db: Database.Database,
    private balanceService: BalanceService,
    hcmUrl: string = process.env.HCM_API_URL || 'http://localhost:3001',
    timeout: number = parseInt(process.env.HCM_API_TIMEOUT_MS || '5000'),
    retryAttempts: number = parseInt(process.env.HCM_RETRY_ATTEMPTS || '3')
  ) {
    this.hcmUrl = hcmUrl;
    this.timeout = timeout;
    this.retryAttempts = retryAttempts;
    this.retryDelayMs = parseInt(process.env.HCM_RETRY_DELAY_MS || '100');
  }

  /**
   * Fetch balance from HCM real-time API
   * Returns null if timeout/error, allowing fallback to local cache
   */
  async fetchBalance(employeeId: string, locationId: string): Promise<Record<BalanceType, number> | null> {
    try {
      const url = `${this.hcmUrl}/api/balances/${employeeId}/${locationId}`;
      const data = await this.makeRequest('GET', url);

      if (!data || !data.balances) {
        return null;
      }

      // Convert HCM response to balance map
      const balances: Record<BalanceType, number> = {
        vacation: data.balances.vacation?.balance || 0,
        sick: data.balances.sick?.balance || 0,
        personal: data.balances.personal?.balance || 0
      };

      return balances;
    } catch (error) {
      console.error(`Failed to fetch balance from HCM: ${error}`);
      return null;
    }
  }

  /**
   * Batch sync: Fetch all employee balances from HCM
   * Location-aware: treats each location independently
   */
  async batchSync(): Promise<{ success: boolean; updatedCount: number; failedLocations: string[] }> {
    try {
      const url = `${this.hcmUrl}/api/balances/batch`;
      const data = await this.makeRequest('GET', url);

      if (!data || !Array.isArray(data.balances)) {
        return { success: false, updatedCount: 0, failedLocations: [] };
      }

      // Group by location for independent processing
      const locationMap = new Map<string, any[]>();
      for (const balance of data.balances) {
        const key = balance.locationId;
        if (!locationMap.has(key)) {
          locationMap.set(key, []);
        }
        locationMap.get(key)!.push(balance);
      }

      let totalUpdated = 0;
      const failedLocations: string[] = [];

      // Process each location independently
      for (const [locationId, balances] of locationMap) {
        try {
          const updates = balances.map((b: any) => ({
            employeeId: b.employeeId,
            locationId: b.locationId,
            balanceType: b.balanceType as BalanceType,
            balance: b.balance,
            version: b.hcmVersion
          }));

          const result = await this.balanceService.batchUpdateBalances(updates);
          totalUpdated += result.updatedCount;
        } catch (error) {
          console.error(`Batch sync failed for location ${locationId}:`, error);
          failedLocations.push(locationId);
        }
      }

      return {
        success: failedLocations.length === 0,
        updatedCount: totalUpdated,
        failedLocations
      };
    } catch (error) {
      console.error(`Batch sync failed:`, error);
      return { success: false, updatedCount: 0, failedLocations: ['all'] };
    }
  }

  /**
   * Submit request to HCM for processing
   */
  async submitRequest(
    requestId: string,
    employeeId: string,
    locationId: string,
    balanceType: BalanceType,
    daysRequested: number
  ): Promise<string> {
    try {
      const url = `${this.hcmUrl}/api/submissions`;
      const body = JSON.stringify({
        employeeId,
        locationId,
        balanceType,
        daysRequested
      });

      const data = await this.makeRequest('POST', url, body);

      if (!data || !data.submissionId) {
        throw new Error('Invalid HCM response: missing submissionId');
      }

      return data.submissionId;
    } catch (error) {
      console.error(`Failed to submit request to HCM: ${error}`);
      throw error;
    }
  }

  /**
   * Poll HCM for request status
   */
  async pollStatus(submissionId: string): Promise<'processing' | 'approved' | 'rejected'> {
    try {
      const url = `${this.hcmUrl}/api/submissions/${submissionId}`;
      const data = await this.makeRequest('GET', url);

      if (!data || !data.status) {
        return 'processing'; // Assume still processing if no response
      }

      return data.status;
    } catch (error) {
      console.error(`Failed to poll HCM status: ${error}`);
      return 'processing'; // Assume still processing on error
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      const url = `${this.hcmUrl}/health`;
      await this.makeRequest('GET', url);
      return true;
    } catch (error) {
      console.error(`HCM health check failed: ${error}`);
      return false;
    }
  }

  /**
   * Make HTTP request with retry logic
   */
  private async makeRequest(
    method: string,
    url: string,
    body?: string,
    attempt: number = 1
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        const urlObj = new URL(url);
        const options = {
          hostname: urlObj.hostname,
          port: urlObj.port || 80,
          path: urlObj.pathname + urlObj.search,
          method,
          timeout: this.timeout,
          headers: {
            'Content-Type': 'application/json'
          }
        };

        const req = http.request(options, (res) => {
          let data = '';

          res.on('data', (chunk) => {
            data += chunk;
          });

          res.on('end', () => {
            if (res.statusCode === 200 || res.statusCode === 201) {
              try {
                resolve(JSON.parse(data));
              } catch (e) {
                resolve(data);
              }
            } else if (res.statusCode === 404) {
              reject(new Error(`Not found: ${url}`));
            } else if (res.statusCode && res.statusCode >= 500) {
              if (attempt < this.retryAttempts) {
                setTimeout(
                  () => this.makeRequest(method, url, body, attempt + 1).then(resolve).catch(reject),
                  this.retryDelayMs * attempt
                );
              } else {
                reject(new Error(`HCM error: ${res.statusCode}`));
              }
            } else {
              reject(new Error(`HTTP ${res.statusCode}`));
            }
          });
        });

        req.on('error', (error) => {
          if (attempt < this.retryAttempts) {
            setTimeout(
              () => this.makeRequest(method, url, body, attempt + 1).then(resolve).catch(reject),
              this.retryDelayMs * attempt
            );
          } else {
            reject(error);
          }
        });

        req.on('timeout', () => {
          req.destroy();
          if (attempt < this.retryAttempts) {
            setTimeout(
              () => this.makeRequest(method, url, body, attempt + 1).then(resolve).catch(reject),
              this.retryDelayMs * attempt
            );
          } else {
            reject(new Error('Request timeout'));
          }
        });

        if (body) {
          req.write(body);
        }

        req.end();
      } catch (error) {
        reject(error);
      }
    });
  }
}
