import { hardhatTest } from '../_support/runCommand';

describe('invariant layer', () => {
  it('passes registry and accounting invariants', () => {
    hardhatTest([
      'test/Registry.invariant.test.ts',
      'test/FeeRouter.invariant.test.ts',
      'test/CollateralManager.invariant.test.ts',
      'test/FundsFlow.blocks-only.authority-path.test.ts',
      'test/Reward/RewardPenaltySequence.invariant.test.ts',
    ]);
  });
});