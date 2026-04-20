/**
 * Main Application Entry Point
 */

import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import DatabaseConnection from './database/database';
import { HCMSyncService } from './services/hcm-sync.service';
import { RequestService } from './services/request.service';
import { BalanceService } from './services/balance.service';
import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { RedisCacheService } from './services/redis-cache.service';
import { HCMSubmissionWorker } from './workers/submission.worker';
import { HCMPollingWorker } from './workers/polling.worker';
import { BatchSyncScheduler } from './workers/batch-sync.scheduler';

async function bootstrap() {
  console.log('🚀 Time-Off Microservice starting...');

  try {
    // Initialize database first
    const dbConnection = new DatabaseConnection(process.env.DB_PATH);
    await dbConnection.initialize();

    // Create NestJS application with initialized DB
    const app = await NestFactory.create(AppModule.forRoot(dbConnection));

    // Register global exception filter
    app.useGlobalFilters(new GlobalExceptionFilter());

    // Get services
    const hcmSyncService = app.get(HCMSyncService);
    const requestService = app.get(RequestService);
    const balanceService = app.get(BalanceService);
    const redisCacheService = app.get(RedisCacheService);
    const db = dbConnection.getDatabase();

    // Connect Redis (graceful — app works without it)
    const redisConnected = await redisCacheService.connect();
    if (redisConnected) {
      console.log('✓ Redis cache connected');
    } else {
      console.warn('⚠ Redis not available — using SQLite only');
    }

    // Check HCM connectivity
    const hcmHealthy = await hcmSyncService.healthCheck();
    if (hcmHealthy) {
      console.log('✓ HCM API is healthy');
    } else {
      console.warn('⚠ Warning: HCM API is not responding');
    }

    // Start background workers
    const pollingIntervalMs = parseInt(process.env.POLLING_INTERVAL_MS || '5000');
    const stuckTimeoutMs = parseInt(process.env.STUCK_REQUEST_TIMEOUT_MS || '3600000');
    const batchSyncIntervalMs = parseInt(process.env.BATCH_SYNC_INTERVAL_MS || '3600000');
    const recoveryIntervalMs = parseInt(process.env.RECOVERY_INTERVAL_MS || '21600000');

    const submissionWorker = new HCMSubmissionWorker(db, requestService, hcmSyncService, pollingIntervalMs);
    const pollingWorker = new HCMPollingWorker(db, requestService, hcmSyncService, balanceService, pollingIntervalMs, stuckTimeoutMs);
    const batchSyncScheduler = new BatchSyncScheduler(db, hcmSyncService, requestService, batchSyncIntervalMs, recoveryIntervalMs, undefined, redisCacheService);

    submissionWorker.start();
    pollingWorker.start();
    batchSyncScheduler.start();
    console.log('✓ Background workers started');

    // Start listening
    const port = process.env.PORT || 3000;
    await app.listen(port);
    console.log(`✓ Application listening on port ${port}`);
    console.log(`✓ Health check available at http://localhost:${port}/health`);
    console.log('✓ Services initialized');
    console.log('✓ Application ready');

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n🛑 Shutting down...');
      submissionWorker.stop();
      pollingWorker.stop();
      batchSyncScheduler.stop();
      console.log('✓ Workers stopped');
      await redisCacheService.disconnect();
      await app.close();
      await dbConnection.close();
      process.exit(0);
    });
  } catch (error) {
    console.error('❌ Bootstrap failed:', error);
    process.exit(1);
  }
}

// Only run bootstrap if this file is executed directly
if (require.main === module) {
  bootstrap();
}

export { bootstrap };
