import {
  arbitrumSepoliaNetworkConfig,
  bnbTestnetNetworkConfig,
  type NetworkConfig,
} from '../networks';
import { type LiveTestProfile } from './types';

function buildLiveTestProfile(config: NetworkConfig): LiveTestProfile {
  const slug = config.slug;
  const isArbitrumSepolia = config.key === 'arbitrumSepolia';

  return {
    networkKey: config.key,
    networkSlug: slug,
    deployOutputFile: isArbitrumSepolia
      ? 'scripts/deployments/arbitrum-sepolia.mock-suite.json'
      : `scripts/deployments/${slug}/core.json`,
    assetsFile: isArbitrumSepolia
      ? 'deployments/assets.arbitrum-sepolia.mock.json'
      : `deployments/assets.${slug}.mock.json`,
    mockAssetsFile: isArbitrumSepolia
      ? 'deployments/mock-assets.arbitrum-sepolia.json'
      : `deployments/mock-assets.${slug}.json`,
    sweepScriptFile: `scripts/tests/live-test/networks/${slug}/sweep-fresh-borrowers.ts`,
    freshBorrowerSweepEnabled: true,
    liveUseMockAssetPack: true,
    livePriceMode: 'bootstrap',
    allowLiquidationManagerPause: true,
    allowDynamicFeeWrite: true,
    networkMaxAttempts: 2,
    defaultTimeoutMs: 300000,
    retryCount: 3,
    retryBackoffMs: 5000,
  };
}

export function getLiveTestProfile(networkName: string): LiveTestProfile {
  const entry = Object.values(liveTestProfiles).find(
    (profile) => profile.networkKey === networkName || profile.networkSlug === networkName,
  );

  if (!entry) {
    throw new Error(`Unsupported live-test network profile: ${networkName}`);
  }

  return entry;
}

export const liveTestProfiles = {
  arbitrumSepolia: buildLiveTestProfile(arbitrumSepoliaNetworkConfig),
  bnbTestnet: buildLiveTestProfile(bnbTestnetNetworkConfig),
} as const;
