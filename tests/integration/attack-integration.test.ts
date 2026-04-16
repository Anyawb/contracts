import { hardhatTest } from '../_support/runCommand';

describe('integration layer - attack and protocol flows', () => {
  it('passes core attack-oriented integration suites', () => {
    hardhatTest([
      'test/FundsFlow.guarantee-reward-penalty.integration.test.ts',
      'test/FundsFlow.fee-router.gateway.integration.test.ts',
      'test/FundsFlow.liquidation.authority-path.test.ts',
      'test/Reward/EasyEmissionController.stale-price-fallback.test.ts',
      'test/Vault/liquidation/SettlementManager.real-ergm.integration.test.ts',
    ]);
  });
});