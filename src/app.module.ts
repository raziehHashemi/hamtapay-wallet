import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfig } from './config/app-config';
import { ConfigModule } from './config/config.module';
import { buildDataSourceOptions } from './database/data-source';
import { IntegrationsModule } from './integrations/integrations.module';
import { DepositsModule } from './modules/deposits/deposits.module';
import { HealthModule } from './modules/health/health.module';
import { IdempotencyModule } from './modules/idempotency/idempotency.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OperationsModule } from './modules/operations/operations.module';
import { OutboxModule } from './modules/outbox/outbox.module';
import { ReconciliationModule } from './modules/reconciliation/reconciliation.module';
import { TransfersModule } from './modules/transfers/transfers.module';
import { WalletsModule } from './modules/wallets/wallets.module';
import { WithdrawalsModule } from './modules/withdrawals/withdrawals.module';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        ...buildDataSourceOptions(config.databaseUrl, config.dbPoolSize),
        autoLoadEntities: true,
      }),
    }),
    IdempotencyModule,
    IntegrationsModule,
    OutboxModule,
    LedgerModule,
    WalletsModule,
    DepositsModule,
    WithdrawalsModule,
    TransfersModule,
    OperationsModule,
    ReconciliationModule,
    NotificationsModule,
    HealthModule,
  ],
})
export class AppModule {}
