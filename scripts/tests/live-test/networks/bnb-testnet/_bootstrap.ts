import fs from 'fs';
import path from 'path';
import hre from 'hardhat';
import { liveTestProfiles } from '../../../../config/profiles';

type PrepareBnbLiveEnvOptions = {
  enableWarmupDefaults?: boolean;
  enablePreflightDefaults?: boolean;
};

function allowLocalForkAlias(): boolean {
  return process.env.BNB_LIVE_ALLOW_LOCAL_FORK === '1';
}

export function prepareBnbLiveEnv(options: PrepareBnbLiveEnvOptions = {}): void {
  const profile = liveTestProfiles.bnbTestnet;

  const usingLocalForkAlias = allowLocalForkAlias() && (hre.network.name === 'localhost' || hre.network.name === 'hardhat');
  if (hre.network.name !== profile.networkKey && !usingLocalForkAlias) {
    throw new Error(`Expected network ${profile.networkKey}, received ${hre.network.name}`);
  }

  process.env.DEPLOY_OUTPUT_FILE = process.env.DEPLOY_OUTPUT_FILE || profile.deployOutputFile;
  process.env.ASSETS_FILE = process.env.ASSETS_FILE || profile.assetsFile;
  process.env.MOCK_ASSET_PACK_OUTPUT =
    process.env.MOCK_ASSET_PACK_OUTPUT || profile.mockAssetsFile;
  process.env.LIVE_NETWORK_ALIAS = process.env.LIVE_NETWORK_ALIAS || profile.networkKey;
  process.env.ALLOW_LIQUIDATION_MANAGER_PAUSE =
    process.env.ALLOW_LIQUIDATION_MANAGER_PAUSE || '1';

  if (options.enablePreflightDefaults) {
    process.env.LIVE_PREFLIGHT_STRICT_VIEW_CACHE =
      process.env.BNB_LIVE_PREFLIGHT_STRICT_VIEW_CACHE || '0';
    process.env.LIVE_PREFLIGHT_STRICT_REWARD_CACHE =
      process.env.BNB_LIVE_PREFLIGHT_STRICT_REWARD_CACHE || '0';
  }

  if (options.enableWarmupDefaults) {
    process.env.LIVE_USE_MOCK_ASSET_PACK = process.env.LIVE_USE_MOCK_ASSET_PACK || '1';
    process.env.LIVE_PRICE_MODE = process.env.LIVE_PRICE_MODE || 'bootstrap';
    process.env.PRIME_VIEW_CACHE = process.env.BNB_PRIME_VIEW_CACHE || process.env.PRIME_VIEW_CACHE || '1';
    process.env.AUTO_GRANT_UPDATE_PRICE =
      process.env.BNB_AUTO_GRANT_UPDATE_PRICE || process.env.AUTO_GRANT_UPDATE_PRICE || '1';
    process.env.LIVE_IGNITE_BORROWER_NATIVE_ETH =
      process.env.LIVE_IGNITE_BORROWER_NATIVE_ETH || '0.01';
    process.env.LIVE_IGNITE_REPAY_MIN_NATIVE_ETH =
      process.env.LIVE_IGNITE_REPAY_MIN_NATIVE_ETH || process.env.LIVE_IGNITE_BORROWER_NATIVE_ETH;
    process.env.LIVE_IGNITE_APPROVE_NATIVE_RESERVE_ETH =
      process.env.LIVE_IGNITE_APPROVE_NATIVE_RESERVE_ETH || '0.001';
    process.env.LIVE_IGNITE_DEPOSIT_NATIVE_RESERVE_ETH =
      process.env.LIVE_IGNITE_DEPOSIT_NATIVE_RESERVE_ETH || '0.001';
    process.env.LIVE_IGNITE_REPAY_NATIVE_RESERVE_ETH =
      process.env.LIVE_IGNITE_REPAY_NATIVE_RESERVE_ETH || '0.001';
  }

  const deployFile = path.resolve(process.cwd(), process.env.DEPLOY_OUTPUT_FILE);
  if (!fs.existsSync(deployFile)) {
    throw new Error(`Missing BNB deploy output file: ${deployFile}. Run deploy first.`);
  }

  const deployMap = JSON.parse(fs.readFileSync(deployFile, 'utf8')) as Record<string, string>;
  if (!deployMap.Registry && !process.env.REGISTRY_ADDRESS) {
    throw new Error(`BNB deploy output has no Registry address: ${deployFile}. Complete deployment first.`);
  }
}