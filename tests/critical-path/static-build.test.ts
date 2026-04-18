import { compileWorkspace } from '../_support/runCommand';
import fs from 'node:fs';
import assert from 'node:assert/strict';

describe('critical-path static/build layer', () => {
  it('compiles the workspace successfully', () => {
    compileWorkspace();
  });

  it('keeps fail-closed legacy mapping for blocks-only SETTLED closeout', () => {
    const content = fs.readFileSync(
      '/Volumes/AI-hosts/contracts/src/Vault/view/modules/BlocksOnlyView.sol',
      'utf8',
    );
    assert.ok(content.includes('_buildFailClosedLegacyBlocksOnlyOrderStateRuntime'));
    assert.ok(content.includes('CloseReason.BLOCKS_MATURITY_CLOSE'));
    assert.ok(content.includes('CollateralDispositionStatus\n                        .DELIVERED_TO_LENDER'));
  });
});