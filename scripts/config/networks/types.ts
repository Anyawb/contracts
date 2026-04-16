export type NetworkGasMode = 'eip1559' | 'legacy';

export interface NetworkConfig {
  key: string;
  slug: string;
  chainId: number;
  rpcEnvKeys: string[];
  explorerBaseUrl?: string;
  nativeSymbol: string;
  defaultConfirmations: number;
  gasMode: NetworkGasMode;
  verifyApiKeyEnvKeys?: string[];
}

export interface RuntimeNetworkConfig extends NetworkConfig {
  url: string;
  accounts: string[];
}

export function resolveEnvFirst(keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key];
    if (value) {
      return value;
    }
  }
  return '';
}

export function resolvePrivateKeyAccounts(): string[] {
  return process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];
}

export function buildRuntimeNetworkConfig(config: NetworkConfig): RuntimeNetworkConfig {
  return {
    ...config,
    url: resolveEnvFirst(config.rpcEnvKeys),
    accounts: resolvePrivateKeyAccounts(),
  };
}
