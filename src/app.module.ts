/**
 * Application Module
 * Main NestJS module that brings together all services and controllers
 */

import { DynamicModule, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { RequestsController } from './controllers/requests.controller';
import { BalancesController } from './controllers/balances.controller';
import { HealthController } from './controllers/health.controller';
import { RequestService } from './services/request.service';
import { BalanceService } from './services/balance.service';
import { HCMSyncService } from './services/hcm-sync.service';
import { DivergenceService } from './services/divergence.service';
import { RedisCacheService } from './services/redis-cache.service';
import { LoggingMiddleware } from './middleware/logging.middleware';
import DatabaseConnection from './database/database';

@Module({})
export class AppModule implements NestModule {
  static forRoot(dbConnection: DatabaseConnection): DynamicModule {
    return {
      module: AppModule,
      controllers: [RequestsController, BalancesController, HealthController],
      providers: [
        {
          provide: 'DATABASE_CONNECTION',
          useValue: dbConnection
        },
        {
          provide: RedisCacheService,
          useFactory: () => {
            return new RedisCacheService(process.env.REDIS_URL);
          }
        },
        {
          provide: BalanceService,
          useFactory: (dbConn: DatabaseConnection, cache: RedisCacheService) => {
            const database = dbConn.getDatabase();
            return new BalanceService(database, cache);
          },
          inject: ['DATABASE_CONNECTION', RedisCacheService]
        },
        {
          provide: HCMSyncService,
          useFactory: (dbConn: DatabaseConnection, balanceService: BalanceService) => {
            const database = dbConn.getDatabase();
            return new HCMSyncService(database, balanceService);
          },
          inject: ['DATABASE_CONNECTION', BalanceService]
        },
        {
          provide: RequestService,
          useFactory: (dbConn: DatabaseConnection, balanceService: BalanceService) => {
            const database = dbConn.getDatabase();
            return new RequestService(database, balanceService);
          },
          inject: ['DATABASE_CONNECTION', BalanceService]
        },
        {
          provide: DivergenceService,
          useFactory: (dbConn: DatabaseConnection) => {
            const database = dbConn.getDatabase();
            return new DivergenceService(database);
          },
          inject: ['DATABASE_CONNECTION']
        }
      ],
      exports: [BalanceService, RequestService, HCMSyncService, DivergenceService, RedisCacheService]
    };
  }

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LoggingMiddleware).forRoutes('*');
  }
}
