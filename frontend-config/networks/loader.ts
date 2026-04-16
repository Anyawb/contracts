import type { FrontendReleaseArtifact } from './release-schema';

import arbitrumSepoliaRelease from './arbitrum-sepolia.release.json';
import bnbTestnetRelease from './bnb-testnet.release.json';

import {
  CONTRACT_ADDRESSES as arbitrumSepoliaAddresses,
  CONTRACT_METADATA as arbitrumSepoliaContractMetadata,
  DEPLOYMENT_METADATA as arbitrumSepoliaDeploymentMetadata,
  NETWORK_CONFIG as arbitrumSepoliaNetworkConfig,
} from './arbitrum-sepolia';
import {
  CONTRACT_ADDRESSES as bnbTestnetAddresses,
  CONTRACT_METADATA as bnbTestnetContractMetadata,
  DEPLOYMENT_METADATA as bnbTestnetDeploymentMetadata,
  NETWORK_CONFIG as bnbTestnetNetworkConfig,
} from './bnb-testnet';

export type EvmNetworkSlug = 'arbitrum-sepolia' | 'bnb-testnet';

type EvmNetworkAlias = EvmNetworkSlug | 'arbitrumSepolia' | 'bnbTestnet';

type EvmNetworkModule = {
  release: FrontendReleaseArtifact;
  deploymentMetadata: typeof arbitrumSepoliaDeploymentMetadata | typeof bnbTestnetDeploymentMetadata;
  contractMetadata: typeof arbitrumSepoliaContractMetadata | typeof bnbTestnetContractMetadata;
  contractAddresses: typeof arbitrumSepoliaAddresses | typeof bnbTestnetAddresses;
  networkConfig: typeof arbitrumSepoliaNetworkConfig | typeof bnbTestnetNetworkConfig;
};

const EVM_NETWORKS: Record<EvmNetworkSlug, EvmNetworkModule> = {
  'arbitrum-sepolia': {
    release: arbitrumSepoliaRelease as FrontendReleaseArtifact,
    deploymentMetadata: arbitrumSepoliaDeploymentMetadata,
    contractMetadata: arbitrumSepoliaContractMetadata,
    contractAddresses: arbitrumSepoliaAddresses,
    networkConfig: arbitrumSepoliaNetworkConfig,
  },
  'bnb-testnet': {
    release: bnbTestnetRelease as FrontendReleaseArtifact,
    deploymentMetadata: bnbTestnetDeploymentMetadata,
    contractMetadata: bnbTestnetContractMetadata,
    contractAddresses: bnbTestnetAddresses,
    networkConfig: bnbTestnetNetworkConfig,
  },
};

function normalizeSlug(network: EvmNetworkAlias): EvmNetworkSlug {
  if (network === 'arbitrumSepolia') return 'arbitrum-sepolia';
  if (network === 'bnbTestnet') return 'bnb-testnet';
  return network;
}

export function getEvmNetworkModule(network: EvmNetworkAlias) {
  return EVM_NETWORKS[normalizeSlug(network)];
}

export function getEvmReleaseArtifact(network: EvmNetworkAlias) {
  return getEvmNetworkModule(network).release;
}

export function getEvmDeploymentMetadata(network: EvmNetworkAlias) {
  return getEvmNetworkModule(network).deploymentMetadata;
}

export function getEvmContractAddresses(network: EvmNetworkAlias) {
  return getEvmNetworkModule(network).contractAddresses;
}

export function getEvmContractMetadata(network: EvmNetworkAlias) {
  return getEvmNetworkModule(network).contractMetadata;
}

export function getEvmContractAddress(network: EvmNetworkAlias, contractName: string) {
  return getEvmReleaseArtifact(network).contracts[contractName]?.address;
}

export function getEvmRegistryKey(network: EvmNetworkAlias, contractName: string) {
  return getEvmReleaseArtifact(network).contracts[contractName]?.registryKey ?? null;
}

export function getEvmNetworkConfig(network: EvmNetworkAlias) {
  return getEvmNetworkModule(network).networkConfig;
}

export function listSupportedEvmNetworks(): EvmNetworkSlug[] {
  return Object.keys(EVM_NETWORKS) as EvmNetworkSlug[];
}