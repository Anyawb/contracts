import { compileWorkspace } from '../_support/runCommand';
import fs from 'node:fs';

describe('critical-path static/build layer', () => {
  it('compiles the workspace successfully', () => {
    compileWorkspace();
  });

  it('keeps fail-closed legacy mapping for blocks-only SETTLED closeout', () => {
    const content = fs.readFileSync(
      '/Volumes/AI-hosts/contracts/src/Vault/view/modules/BlocksOnlyView.sol',
      'utf8',
    );
    expect(content).toContain('_buildFailClosedLegacyBlocksOnlyOrderStateRuntime');
    expect(content).toContain('CloseReason.BLOCKS_MATURITY_CLOSE');
    expect(content).toContain('CollateralDispositionStatus\n                        .DELIVERED_TO_LENDER');
  });
});