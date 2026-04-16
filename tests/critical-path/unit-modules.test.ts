import { hardhatTest } from '../_support/runCommand';

describe('critical-path unit/module layer', () => {
  it('passes core security and module regression suites', () => {
    hardhatTest([
      'test/CollateralManager.security.test.ts',
      'test/EarlyRepaymentGuaranteeManager.security.test.ts',
      'test/Vault/view/BlocksOnlyView.test.ts',
      'test/Reward/EasyEmissionConfig.datapush.test.ts',
      'test/Reward/RewardAccrualManager.offsetPenaltyOnReward.test.ts',
    ]);
  });

  it('passes upgrade and storage safety suites', () => {
    hardhatTest([
      'test/RegistryStorageMigration.test.ts',
      'test/VaultAccessUpgrade.test.ts',
      'test/Vault/view/BlocksOnlyView.test.ts',
    ]);
  });
});