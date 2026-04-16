import { hardhatTest } from '../_support/runCommand';

describe('integration layer - concurrency and execution ordering', () => {
  it('passes current concurrency and cross-module integration suites', () => {
    hardhatTest([
      'test/VaultRouter.concurrent-update-phase0.test.ts',
      'test/VaultBusinessLogic.stats-integration.test.ts',
      'test/FundsFlow.blocks-only.authority-path.test.ts',
      'test/GuaranteeAndRisk.integrated.test.ts',
    ]);
  });
});