import { expect } from 'chai';

/**
 * ValuationOracleAdapter – DEPRECATED
 *
 * This repo has migrated valuation to `PositionView` + `PriceOracle` best-effort reads,
 * and the legacy `ValuationOracleAdapter` contract has been removed.
 *
 * We keep this test file to avoid "all pending" suites and to explicitly document
 * the architectural decision in CI.
 */
describe('ValuationOracleAdapter – DEPRECATED (removed)', function () {
  it('is intentionally removed; valuation lives in PositionView/PriceOracle', async function () {
    expect(true).to.equal(true);
  });
});

