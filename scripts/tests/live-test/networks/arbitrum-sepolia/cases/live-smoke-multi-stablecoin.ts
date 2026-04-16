import { envStr } from "../../../../_addressResolver";
import { runMockLiveIgnition } from "../core/_mockLiveIgnition";
import { primeMockLiveViewCache } from "../core/_mockLiveViewCache";
import { getAssetBootstrapPriceValue, loadMockAssetPack, loadMockAssetPackData, type MockAssetPackAsset } from "../core/_mockLiveUtils";
import { logLiveScriptFailure, logLiveScriptSuccess } from "../core/_scriptStatus";

type SmokeAssetTarget = {
  symbol: string;
  address: string;
  decimals: number;
  priceValue: string;
  sourceId?: string;
};

// 支持直接用环境变量注入若干借款资产，适合快速覆盖自定义组合。
function parseInlineTargets(raw: string): SmokeAssetTarget[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [symbol, address, decimals, priceValue, sourceId] = item.split(":").map((part) => part.trim());
      if (!symbol || !address || !decimals || !priceValue) {
        throw new Error(
          `invalid MULTI_STABLECOIN_ASSETS entry=${item}. expected symbol:address:decimals:priceValue[:sourceId]`,
        );
      }
      return {
        symbol,
        address,
        decimals: Number(decimals),
        priceValue,
        sourceId: sourceId || undefined,
      };
    });
}

// 默认从 mock asset pack 里挑一组稳定币，批量做借款侧 smoke。
function parseBorrowTargetsFromPack(assets: MockAssetPackAsset[]): SmokeAssetTarget[] {
  const { packFile } = loadMockAssetPackData();
  const requestedRaw = envStr("MULTI_STABLECOIN_SYMBOLS");
  const requested = (requestedRaw ?? "mUSDC,mUSDT,mHKD,mSGD")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const missing: string[] = [];
  const targets: SmokeAssetTarget[] = [];

  for (const symbol of requested) {
    const asset = assets.find((item) => item.symbol.toLowerCase() === symbol.toLowerCase());
    if (!asset) {
      missing.push(symbol);
      continue;
    }
    targets.push({
      symbol: asset.symbol,
      address: asset.address,
      decimals: asset.decimals,
      priceValue: getAssetBootstrapPriceValue(asset),
      sourceId: asset.sourceId,
    } satisfies SmokeAssetTarget);
  }

  if (missing.length > 0 && requestedRaw) {
    throw new Error(
      `stablecoins ${missing.join(", ")} not found in mock asset pack ${packFile}. Refresh that pack or pass MULTI_STABLECOIN_ASSETS explicitly.`,
    );
  }
  if (targets.length === 0) {
    throw new Error(`no stablecoin targets found in mock asset pack ${packFile}. Refresh that pack or pass MULTI_STABLECOIN_ASSETS explicitly.`);
  }
  if (missing.length > 0) {
    console.log(`  [Notice] skip missing stablecoins from default target set: ${missing.join(", ")}`);
  }

  return targets;
}

// 抵押品侧可显式指定多资产；未指定时就沿用当前默认 collateral。
function parseCollateralTargetsFromPack(assets: MockAssetPackAsset[]): SmokeAssetTarget[] {
  const { packFile } = loadMockAssetPackData();
  const requestedRaw = envStr("MULTI_COLLATERAL_SYMBOLS") ?? envStr("MULTI_RWA_SYMBOLS");
  if (!requestedRaw) {
    const selected = loadMockAssetPack().collateralAsset;
    return [{
      symbol: selected.symbol,
      address: selected.address,
      decimals: selected.decimals,
      priceValue: getAssetBootstrapPriceValue(selected),
      sourceId: selected.sourceId,
    }];
  }

  const requested = requestedRaw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return requested.map((symbol) => {
    const asset = assets.find((item) => item.symbol.toLowerCase() === symbol.toLowerCase());
    if (!asset) {
      throw new Error(
        `collateral ${symbol} not found in mock asset pack ${packFile}. Refresh that pack or clear MULTI_COLLATERAL_SYMBOLS.`,
      );
    }
    return {
      symbol: asset.symbol,
      address: asset.address,
      decimals: asset.decimals,
      priceValue: getAssetBootstrapPriceValue(asset),
      sourceId: asset.sourceId,
    } satisfies SmokeAssetTarget;
  });
}

async function main() {
  const packAssets = loadMockAssetPackData().pack.assets;
  const explicitTargets = envStr("MULTI_STABLECOIN_ASSETS");
  const borrowTargets = explicitTargets
    ? parseInlineTargets(explicitTargets)
    : parseBorrowTargetsFromPack(packAssets);
  const collateralTargets = parseCollateralTargetsFromPack(packAssets);

  const originalEnv = {
    BORROW_ASSET_ADDRESS: process.env.BORROW_ASSET_ADDRESS,
    BORROW_SYMBOL: process.env.BORROW_SYMBOL,
    BORROW_ASSET_DECIMALS: process.env.BORROW_ASSET_DECIMALS,
    BORROW_PRICE_VALUE: process.env.BORROW_PRICE_VALUE,
    BORROW_SOURCE_ID: process.env.BORROW_SOURCE_ID,
    BORROW_COINGECKO_ID: process.env.BORROW_COINGECKO_ID,
    COLLATERAL_ASSET_ADDRESS: process.env.COLLATERAL_ASSET_ADDRESS,
    COLLATERAL_SYMBOL: process.env.COLLATERAL_SYMBOL,
    COLLATERAL_PRICE_VALUE: process.env.COLLATERAL_PRICE_VALUE,
    COLLATERAL_SOURCE_ID: process.env.COLLATERAL_SOURCE_ID,
    COLLATERAL_COINGECKO_ID: process.env.COLLATERAL_COINGECKO_ID,
  };

  try {
    console.log("=== Multi-Stablecoin Live Smoke ===");
    console.log(`BorrowTargets=${borrowTargets.map((item) => item.symbol).join(", ")}`);
    console.log(`CollateralTargets=${collateralTargets.map((item) => item.symbol).join(", ")}`);

    // 外层切 collateral，内层切 borrow asset，逐个组合执行完整 warmup。
    for (const collateralTarget of collateralTargets) {
      process.env.COLLATERAL_ASSET_ADDRESS = collateralTarget.address;
      process.env.COLLATERAL_SYMBOL = collateralTarget.symbol;
      process.env.COLLATERAL_PRICE_VALUE = collateralTarget.priceValue;
      if (collateralTarget.sourceId) {
        process.env.COLLATERAL_SOURCE_ID = collateralTarget.sourceId;
        process.env.COLLATERAL_COINGECKO_ID = collateralTarget.sourceId;
      } else {
        delete process.env.COLLATERAL_SOURCE_ID;
        delete process.env.COLLATERAL_COINGECKO_ID;
      }

      for (const borrowTarget of borrowTargets) {
        // 下游脚本通过环境变量感知当前资产组合，所以这里按轮次覆写。
        process.env.BORROW_ASSET_ADDRESS = borrowTarget.address;
        process.env.BORROW_SYMBOL = borrowTarget.symbol;
        process.env.BORROW_ASSET_DECIMALS = String(borrowTarget.decimals);
        process.env.BORROW_PRICE_VALUE = borrowTarget.priceValue;
        if (borrowTarget.sourceId) {
          process.env.BORROW_SOURCE_ID = borrowTarget.sourceId;
          process.env.BORROW_COINGECKO_ID = borrowTarget.sourceId;
        } else {
          delete process.env.BORROW_SOURCE_ID;
          delete process.env.BORROW_COINGECKO_ID;
        }

        await runMockLiveIgnition({
          label: `Mock Live Warmup [${borrowTarget.symbol}/${collateralTarget.symbol}]`,
          defaultEnableWrite: true,
          defaultAllowSingleParty: false,
          collateralAmountUnitsDefault: "10",
          borrowAmountUnitsDefault: "1200",
        });

        if ((process.env.PRIME_VIEW_CACHE ?? "1") !== "0") {
          await primeMockLiveViewCache({
            label: `Mock Live ViewCache Prime [${borrowTarget.symbol}/${collateralTarget.symbol}]`,
          });
        }
      }
    }

    logLiveScriptSuccess(__filename);
  } finally {
    // 恢复现场，避免影响同一进程里后续脚本的资产选择。
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

export const liveScriptPromise = main().catch((error) => {
  logLiveScriptFailure(__filename, error);
  process.exit(1);
});