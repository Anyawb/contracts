import { expect } from "chai";

import {
  getAssetBootstrapPriceValue,
  parseAssetBootstrapPrice,
  type MockAssetPackAsset,
} from "../../scripts/tests/live-test/networks/bnb-testnet/core/_mockLiveUtils";

describe("mock live utils price value helpers", function () {
  function buildAsset(overrides: Partial<MockAssetPackAsset> = {}): MockAssetPackAsset {
    return {
      id: "asset-1",
      name: "Asset One",
      symbol: "AST1",
      kind: "mock-erc20",
      decimals: 6,
      initialSupply: "0",
      sourceId: "asset-1",
      maxPriceAge: 3600,
      active: true,
      address: "0x0000000000000000000000000000000000000001",
      ...overrides,
    };
  }

  it("prefers bootstrapPriceValue and falls back to defaultPriceValue", function () {
    const explicitValue = buildAsset({
      bootstrapPriceValue: "1.25",
      defaultPriceValue: "9.99",
    });
    expect(getAssetBootstrapPriceValue(explicitValue)).to.equal("1.25");

    const defaultValue = buildAsset({
      defaultPriceValue: "2.5",
    });
    expect(getAssetBootstrapPriceValue(defaultValue)).to.equal("2.5");
  });

  it("parses bootstrap price with the asset's own decimals", function () {
    const usdcLike = buildAsset({
      decimals: 6,
      bootstrapPriceValue: "1",
    });
    const ethLike = buildAsset({
      decimals: 18,
      bootstrapPriceValue: "2200",
      address: "0x0000000000000000000000000000000000000002",
    });

    expect(parseAssetBootstrapPrice(usdcLike)).to.equal(1_000_000n);
    expect(parseAssetBootstrapPrice(ethLike)).to.equal(2_200n * 10n ** 18n);
  });
});