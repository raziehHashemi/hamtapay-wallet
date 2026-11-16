import { Global, Module } from '@nestjs/common';
import { PayoutGateway } from './payout/payout-gateway';
import { SimulatorPayoutClient } from './payout/simulator-payout.client';
import { PaymentGateway } from './psp/payment-gateway';
import { SimulatorPspClient } from './psp/simulator-psp.client';

/** Binds the ports to the HTTP adapters. Tests override these providers with deterministic fakes. */
@Global()
@Module({
  providers: [
    { provide: PaymentGateway, useClass: SimulatorPspClient },
    { provide: PayoutGateway, useClass: SimulatorPayoutClient },
  ],
  exports: [PaymentGateway, PayoutGateway],
})
export class IntegrationsModule {}
