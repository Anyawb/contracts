import { buildRuntimeNetworkConfig, type NetworkConfig } from './types';

export const arbitrumSepoliaNetworkConfig: NetworkConfig = {
  key: 'arbitrumSepolia',
  slug: 'arbitrum-sepolia',
  chainId: 421614,
  rpcEnvKeys: ['ARBITRUM_SEPOLIA_RPC_URL', 'ARBITRUM_SEPOLIA_URL'],
  explorerBaseUrl: 'https://sepolia.arbiscan.io',
  nativeSymbol: 'ETH',
  defaultConfirmations: 2,
  gasMode: 'eip1559',
  verifyApiKeyEnvKeys: ['ARBISCAN_API_KEY'],
};

export const arbitrumSepoliaRuntimeNetworkConfig = buildRuntimeNetworkConfig(
  arbitrumSepoliaNetworkConfig,
);
