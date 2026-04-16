import {
  arbitrumSepoliaNetworkConfig,
  bnbTestnetNetworkConfig,
  type NetworkConfig,
} from '../networks';
import { type DeployProfile } from './types';

function buildDeployProfile(config: NetworkConfig): DeployProfile {
  const slug = config.slug;
  const isArbitrumSepolia = config.key === 'arbitrumSepolia';

  return {
    networkKey: config.key,
    networkSlug: slug,
    entrypoints: {
      deployScriptFile: `scripts/deploy/networks/${slug}/deploy.ts`,
    },
    inputs: {
      mockAssetPackSpecFile: config.key === 'bnbTestnet'
        ? `deployments/assets/${slug}/mock-assets.json`
        : undefined,
      rwaPriceCatalogTemplateFile: config.key === 'bnbTestnet'
        ? `deployments/assets/${slug}/rwa-price-catalog.json`
        : undefined,
    },
    outputs: {
      coreDeployFile: isArbitrumSepolia
        ? `scripts/deployments/${slug}.json`
        : `scripts/deployments/${slug}/core.json`,
      manifestFile: isArbitrumSepolia
        ? `scripts/deployments/${slug}.manifest.json`
        : `scripts/deployments/${slug}/manifest.json`,
      baselineFile: isArbitrumSepolia
        ? `scripts/deployments/${slug}.baseline.json`
        : `scripts/deployments/${slug}/baseline.json`,
      mockSuiteDeployFile: isArbitrumSepolia
        ? `scripts/deployments/${slug}.mock-suite.json`
        : `scripts/deployments/${slug}/mock-suite.json`,
      frontendConfigFile: `frontend-config/networks/${slug}.ts`,
      generatedAssetsFile: `deployments/assets.${slug}.mock.json`,
      generatedMockAssetPackFile: `deployments/mock-assets.${slug}.json`,
      exportedRwaPriceCatalogFile: isArbitrumSepolia
        ? `deployments/rwa-price-catalog.${slug}.json`
        : undefined,
    },
  };
}

export const deployProfiles = {
  arbitrumSepolia: buildDeployProfile(arbitrumSepoliaNetworkConfig),
  bnbTestnet: buildDeployProfile(bnbTestnetNetworkConfig),
} as const;
