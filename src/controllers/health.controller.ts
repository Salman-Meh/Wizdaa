/**
 * Health Check Controller
 * Provides health status endpoints for monitoring
 */

import { Controller, Get, Inject } from '@nestjs/common';
import { HCMSyncService } from '../services/hcm-sync.service';
import { RedisCacheService } from '../services/redis-cache.service';
import DatabaseConnection from '../database/database';

@Controller('health')
export class HealthController {
  constructor(
    private hcmSyncService: HCMSyncService,
    private redisCacheService: RedisCacheService,
    @Inject('DATABASE_CONNECTION') private db: DatabaseConnection
  ) {}

  /**
   * GET /health
   * Returns overall application health
   */
  @Get()
  async getHealth() {
    const timestamp = new Date().toISOString();

    try {
      // Check database connectivity
      const dbHealthy = this.db.isInitialized();

      // Check HCM connectivity
      const hcmHealthy = await this.hcmSyncService.healthCheck();

      // Check Redis connectivity
      const redisHealthy = await this.redisCacheService.healthCheck();

      const status = dbHealthy && hcmHealthy ? 'healthy' : 'degraded';

      return {
        status,
        timestamp,
        services: {
          database: dbHealthy ? 'up' : 'down',
          hcm: hcmHealthy ? 'up' : 'down',
          redis: redisHealthy ? 'up' : 'down'
        }
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        timestamp,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * GET /health/ready
   * Kubernetes readiness probe
   * Returns 200 only if service is fully ready
   */
  @Get('ready')
  async getReady() {
    try {
      const dbHealthy = this.db.isInitialized();
      const hcmHealthy = await this.hcmSyncService.healthCheck();

      if (dbHealthy && hcmHealthy) {
        return { status: 'ready' };
      } else {
        throw new Error('Service not ready');
      }
    } catch (error) {
      throw error;
    }
  }

  /**
   * GET /health/live
   * Kubernetes liveness probe
   * Returns 200 if service is still running
   */
  @Get('live')
  getLive() {
    return {
      status: 'alive',
      timestamp: new Date().toISOString()
    };
  }
}
