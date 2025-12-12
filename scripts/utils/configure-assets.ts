import fs from 'fs';
import path from 'path';

export interface AssetConfigItem {
  address: string;
  coingeckoId: string;
  decimals: number;
  maxPriceAge: number;
  active?: boolean;
}

export interface AssetsConfigFile {
  chainId?: number;
  network?: string;
  assets: AssetConfigItem[];
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
    path.join(__dirname, '../config', `assets.${networkName}.json`),
    path.join(__dirname, '../config', `assets.${chainId}.json`),
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
 * Apply assets configuration to PriceOracle.
 * Expects the caller to have SET_PARAMETER role.
 */
export async function configureAssets(
  ethers: any,
  priceOracleAddress: string,
  assets: AssetConfigItem[]
): Promise<void> {
  if (!assets.length) return;
  const priceOracle = await ethers.getContractAt('PriceOracle', priceOracleAddress);
  for (const a of assets) {
    await priceOracle.configureAsset(a.address, a.coingeckoId, a.decimals, a.maxPriceAge);
    if (typeof a.active === 'boolean') {
      await priceOracle.setAssetActive(a.address, a.active);
    }
  }
}


