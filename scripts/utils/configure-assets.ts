import fs from 'fs';
import path from 'path';

export interface AssetConfigItem {
  address: string;
  sourceId: string;
  decimals: number;
  maxPriceAge: number;
  active?: boolean;
}

export interface AssetsConfigFile {
  chainId?: number;
  network?: string;
  assets: AssetConfigItem[];
}

export interface SettlementAssetResolution {
  assets: AssetConfigItem[];
  settlementAsset: AssetConfigItem;
  source: string;
}

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : undefined;
}

function envBool(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(value)) return true;
  if (["0", "false", "no", "n"].includes(value)) return false;
  return undefined;
}

function envStrWithLegacy(name: string, legacyName?: string): string | undefined {
  const primary = process.env[name]?.trim();
  if (primary) return primary;
  if (!legacyName) return undefined;
  const legacy = process.env[legacyName]?.trim();
  return legacy && legacy.length > 0 ? legacy : undefined;
}

function normalizeAddress(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed.toLowerCase() : undefined;
}

function pickSettlementAssetFromConfig(assets: AssetConfigItem[]): SettlementAssetResolution {
  const sourceOverride = envStrWithLegacy("SETTLEMENT_TOKEN_SOURCE_ID", "SETTLEMENT_TOKEN_COINGECKO_ID");
  if (sourceOverride) {
    const matched = assets.find((asset) => asset.sourceId === sourceOverride);
    if (!matched) {
      throw new Error(
        `SETTLEMENT_TOKEN_SOURCE_ID=${sourceOverride} 未在资产配置中找到匹配项（兼容旧变量: SETTLEMENT_TOKEN_COINGECKO_ID）`,
      );
    }
    return {
      assets,
      settlementAsset: matched,
      source: `config sourceId ${sourceOverride}`,
    };
  }

  const defaultAsset = assets.find((asset) => asset.sourceId === "usd-coin");
  if (!defaultAsset) {
    throw new Error(
      "缺少默认 Settlement Token 配置：未找到 sourceId=usd-coin，也未提供 SETTLEMENT_TOKEN_ADDRESS / SETTLEMENT_TOKEN_SOURCE_ID",
    );
  }
  return {
    assets,
    settlementAsset: defaultAsset,
    source: "default sourceId usd-coin",
  };
}

export function resolveSettlementAssetConfig(
  networkName: string,
  chainId: number,
): SettlementAssetResolution {
  const assets = loadAssetsConfig(networkName, chainId);
  const addressOverride = normalizeAddress(process.env.SETTLEMENT_TOKEN_ADDRESS);

  if (!addressOverride) {
    return pickSettlementAssetFromConfig(assets);
  }

  const matched = assets.find(
    (asset) => normalizeAddress(asset.address) === addressOverride,
  );
  if (matched) {
    const settlementAsset: AssetConfigItem = {
      ...matched,
      sourceId:
        envStrWithLegacy("SETTLEMENT_TOKEN_SOURCE_ID", "SETTLEMENT_TOKEN_COINGECKO_ID") || matched.sourceId,
      decimals: envInt("SETTLEMENT_TOKEN_DECIMALS") ?? matched.decimals,
      maxPriceAge: envInt("SETTLEMENT_TOKEN_MAX_PRICE_AGE") ?? matched.maxPriceAge,
      active: envBool("SETTLEMENT_TOKEN_ACTIVE") ?? matched.active,
    };
    const mergedAssets = assets.map((asset) =>
      normalizeAddress(asset.address) === addressOverride ? settlementAsset : asset,
    );
    return {
      assets: mergedAssets,
      settlementAsset,
      source: `SETTLEMENT_TOKEN_ADDRESS matched config ${matched.address}`,
    };
  }

  const decimals = envInt("SETTLEMENT_TOKEN_DECIMALS");
  if (decimals === undefined) {
    throw new Error(
      "SETTLEMENT_TOKEN_ADDRESS 未出现在资产配置中时，必须同时提供 SETTLEMENT_TOKEN_DECIMALS",
    );
  }

  const settlementAsset: AssetConfigItem = {
    address: process.env.SETTLEMENT_TOKEN_ADDRESS!.trim(),
    sourceId:
      envStrWithLegacy("SETTLEMENT_TOKEN_SOURCE_ID", "SETTLEMENT_TOKEN_COINGECKO_ID") ||
      `manual-${addressOverride.slice(2, 10)}`,
    decimals,
    maxPriceAge: envInt("SETTLEMENT_TOKEN_MAX_PRICE_AGE") ?? 3600,
    active: envBool("SETTLEMENT_TOKEN_ACTIVE") ?? true,
  };

  return {
    assets: [...assets, settlementAsset],
    settlementAsset,
    source: `SETTLEMENT_TOKEN_ADDRESS appended manual asset ${settlementAsset.address}`,
  };
}

/**
 * Load assets config with the following precedence:
 * 1) process.env.ASSETS_FILE (absolute or relative path)
 * 2) scripts/config/assets.<network>.json
 * 3) scripts/config/assets.<chainId>.json
 * 4) scripts/config/assets.default.json
 */
export function loadAssetsConfig(networkName: string, chainId: number): AssetConfigItem[] {
  const candidates: string[] = [];
  if (process.env.ASSETS_FILE) {
    const p = path.isAbsolute(process.env.ASSETS_FILE)
      ? process.env.ASSETS_FILE
      : path.join(process.cwd(), process.env.ASSETS_FILE);
    candidates.push(p);
  }
  candidates.push(
    path.join(__dirname, '..', `assets.${networkName}.json`),
    path.join(__dirname, '..', `assets.${chainId}.json`),
    path.join(__dirname, '../config', `assets.${networkName}.json`),
    path.join(__dirname, '../config', `assets.${chainId}.json`),
    path.join(__dirname, '..', 'assets.default.json'),
    path.join(__dirname, '../config', 'assets.default.json')
  );

  for (const fp of candidates) {
    try {
      if (fs.existsSync(fp)) {
        const raw = fs.readFileSync(fp, 'utf-8');
        const parsed = JSON.parse(raw) as AssetsConfigFile;
        if (parsed && Array.isArray(parsed.assets)) {
          return parsed.assets;
        }
      }
    } catch {
      // continue to next candidate
    }
  }
  return [];
}

/**
 * Apply assets configuration to PriceOracle and PriceUpdater.
 * Expects the caller to have SET_PARAMETER role.
 */
export async function configureAssets(
  ethers: any,
  priceOracleAddress: string,
  assets: AssetConfigItem[],
  priceUpdaterAddress?: string,
): Promise<void> {
  if (!assets.length) return;
  const priceOracle = await ethers.getContractAt(
    [
      'function configureAsset(address asset,string sourceId,uint256 assetDecimals,uint256 maxPriceAgeBlocks)',
      'function setAssetActive(address asset,bool isActive)',
    ],
    priceOracleAddress,
  );
  const priceUpdater = priceUpdaterAddress
    ? await ethers.getContractAt(
        [
          'function configureAssetWithDecimals(address asset,string sourceId,uint8 decimals)',
        ],
        priceUpdaterAddress,
      )
    : null;
  for (const a of assets) {
    if (priceUpdater) {
      const updaterTx = await priceUpdater.configureAssetWithDecimals(
        a.address,
        a.sourceId,
        a.decimals,
      );
      await updaterTx.wait();
    }

    const configureTx = await priceOracle.configureAsset(
      a.address,
      a.sourceId,
      a.decimals,
      a.maxPriceAge,
    );
    await configureTx.wait();

    if (typeof a.active === 'boolean') {
      const setActiveTx = await priceOracle.setAssetActive(a.address, a.active);
      await setActiveTx.wait();
    }
  }
}


