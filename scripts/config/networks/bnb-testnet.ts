import { buildRuntimeNetworkConfig, type NetworkConfig } from './types';

export const bnbTestnetNetworkConfig: NetworkConfig = {
  key: 'bnbTestnet',
  slug: 'bnb-testnet',
  chainId: 97,
  rpcEnvKeys: ['BNB_TESTNET_RPC_URL', 'BSC_TESTNET_RPC_URL', 'BNB_TESTNET_URL', 'BSC_TESTNET_URL'],
  explorerBaseUrl: 'https://testnet.bscscan.com',
  nativeSymbol: 'tBNB',
  defaultConfirmations: 2,
  gasMode: 'eip1559',
  verifyApiKeyEnvKeys: ['BSCSCAN_API_KEY', 'BSCSCAN_TESTNET_API_KEY'],
};

export const bnbTestnetRuntimeNetworkConfig = buildRuntimeNetworkConfig(bnbTestnetNetworkConfig);
