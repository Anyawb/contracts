#!/usr/bin/env ts-node

import * as fs from 'fs';
import * as path from 'path';
import { keccak256, toUtf8Bytes } from 'ethers';

const ROOT = process.cwd();
const DEFAULT_CONTRACTS_REPO_ROOT = '/Volumes/AI-hosts/contracts';
const CONTRACTS_REPO_ROOT = process.env.CONTRACTS_REPO_ROOT?.trim() || DEFAULT_CONTRACTS_REPO_ROOT;
const EXTERNAL_MODULE_KEYS_PATH = path.resolve(CONTRACTS_REPO_ROOT, 'frontend-config/moduleKeys.ts');
const EXTERNAL_CONTRACTS_PATH = path.resolve(CONTRACTS_REPO_ROOT, 'frontend-config/contracts-arbitrum-sepolia.ts');
const EXTERNAL_DEPLOYMENT_MANIFEST_PATH = path.resolve(CONTRACTS_REPO_ROOT, 'deployments/addresses.arbitrum-sepolia.json');
const WORKSPACE_MODULE_KEYS_PATH = path.resolve(ROOT, 'frontend-config/moduleKeys.ts');
const WORKSPACE_CONTRACTS_PATH = path.resolve(ROOT, 'frontend-config/contracts-arbitrum-sepolia.ts');
const BACKEND_CONFIG_DIR = path.resolve(ROOT, 'lending-backend/src/services/frontend-migrated/config');
const BACKEND_MODULE_KEYS_PATH = path.resolve(BACKEND_CONFIG_DIR, 'moduleKeys.ts');
const BACKEND_CONTRACTS_PATH = path.resolve(BACKEND_CONFIG_DIR, 'contracts-localhost.ts');

const MODULE_KEY_EXPORTS = [
  ['KEY_REGISTRY', 'KEY_REGISTRY'],
  ['KEY_VAULT_CORE', 'KEY_VAULT_CORE'],
  ['KEY_VAULT_VIEW', 'KEY_POSITION_VIEW'],
  ['KEY_REWARD_VIEW', 'KEY_REWARD_VIEW'],
  ['KEY_LENDING_ENGINE', 'KEY_LE'],
  ['KEY_EASY_CONSUMPTION', 'KEY_EASY_CONSUMPTION'],
  ['KEY_REWARD_MANAGER', 'KEY_RM'],
] as const;

const CONTRACT_EXPORTS = [
  'Registry',
  'RegistryDynamicModuleKey',
  'VaultCore',
  'PositionView',
  'DashboardView',
  'UserView',
  'RewardView',
  'HealthView',
  'CollateralManager',
  'LendingEngine',
] as const;

function readFileStrict(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`file not found: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function firstExistingPath(paths: string[]): string | null {
  for (const candidate of paths) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function extractBlock(source: string, startToken: string, endToken: string): string {
  const startIndex = source.indexOf(startToken);
  if (startIndex < 0) {
    throw new Error(`missing block start: ${startToken}`);
  }
  const endIndex = source.indexOf(endToken, startIndex);
  if (endIndex < 0) {
    throw new Error(`missing block end: ${endToken}`);
  }
  return source.slice(startIndex + startToken.length, endIndex);
}

function parseModuleKeyInputs(source: string): Record<string, string> {
  const block = extractBlock(source, 'export const MODULE_KEY_INPUTS = {', '} as const;');
  const mapping: Record<string, string> = {};
  const entryPattern = /^\s*([A-Z0-9_]+): '([^']+)',?$/gm;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(block)) !== null) {
    mapping[match[1]] = match[2];
  }
  return mapping;
}

function parseContractAddresses(source: string): Record<string, string> {
  const block = extractBlock(source, 'export const CONTRACT_ADDRESSES = {', '};');
  const mapping: Record<string, string> = {};
  const entryPattern = /^\s*([A-Za-z][A-Za-z0-9_]+): '((?:0x)?[A-Fa-f0-9]{40})',?$/gm;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(block)) !== null) {
    mapping[match[1]] = match[2];
  }
  return mapping;
}

function parseNetworkConfigFromTs(source: string): {
  chainId?: number;
  name?: string;
  rpcUrl?: string;
  explorerUrl?: string;
} {
  const block = extractBlock(source, 'export const NETWORK_CONFIG = {', '};');
  const chainIdMatch = block.match(/chainId:\s*Number\([^)]*\|\|\s*(\d+)\)|chainId:\s*(\d+)/);
  const nameMatch = block.match(/name:\s*(?:process\.env\.[A-Z0-9_]+\s*\|\|\s*)?'([^']+)'/);
  const rpcUrlMatch = block.match(/rpcUrl:\s*(?:process\.env\.[A-Z0-9_]+\s*\|\|\s*)?'([^']+)'/);
  const explorerUrlMatch = block.match(/explorerUrl:\s*(?:process\.env\.[A-Z0-9_]+\s*\|\|\s*)?'([^']+)'|explorer:\s*'([^']+)'/);

  return {
    chainId: Number(chainIdMatch?.[1] || chainIdMatch?.[2] || 421614),
    name: nameMatch?.[1] || 'arbitrum-sepolia',
    rpcUrl: rpcUrlMatch?.[1] || 'https://sepolia-rollup.arbitrum.io/rpc',
    explorerUrl: explorerUrlMatch?.[1] || explorerUrlMatch?.[2] || 'https://sepolia.arbiscan.io',
  };
}

function parseDeploymentManifest(source: string): {
  contracts: Record<string, string>;
  network: {
    chainId?: number;
    name?: string;
    rpcUrl?: string;
    explorerUrl?: string;
  };
} {
  const parsed = JSON.parse(source) as {
    contracts?: Record<string, string | { address?: string }>;
    network?: { chainId?: number; name?: string; rpcUrl?: string; explorerUrl?: string; explorer?: string };
  };
  const contracts = Object.entries(parsed.contracts || {}).reduce<Record<string, string>>((acc, [name, value]) => {
    if (typeof value === 'string' && value.trim()) {
      acc[name] = value;
    } else if (value && typeof value === 'object' && typeof value.address === 'string' && value.address.trim()) {
      acc[name] = value.address;
    }
    return acc;
  }, {});

  return {
    contracts,
    network: {
      chainId: parsed.network?.chainId,
      name: parsed.network?.name,
      rpcUrl: parsed.network?.rpcUrl,
      explorerUrl: parsed.network?.explorerUrl || parsed.network?.explorer,
    },
  };
}

function buildBackendModuleKeys(moduleKeyInputs: Record<string, string>, sourceLabel: string): string {
  const timestamp = new Date().toISOString();
  const lines = MODULE_KEY_EXPORTS.map(([backendName, frontendName]) => {
    const input = moduleKeyInputs[frontendName];
    if (!input) {
      throw new Error(`missing frontend module key: ${frontendName}`);
    }
    return `export const ${backendName} = '${keccak256(toUtf8Bytes(input))}' as const;`;
  });

  return `// 此文件由 frontend-config/scripts/generateBackendFrontendMigratedConfig.ts 自动生成。
// 历史兼容来源: ${sourceLabel}
// 当前正式生成链见 docs/Contract-Artifact-Generation-Guide.md。
// 生成时间: ${timestamp}
// backend 运行时不再本地 keccak 计算，避免与合约产物出现漂移。
${lines.join('\n')}

/**
 * @deprecated 契约侧标准 key 已迁移为 KEY_EASY_CONSUMPTION。
 * 仅为兼容旧调用临时保留，新增代码禁止继续使用。
 */
export const KEY_REWARD_CONSUMPTION = KEY_EASY_CONSUMPTION;
`;
}

function buildBackendContracts(
  contracts: Record<string, string>,
  sourceLabel: string,
  network?: {
    chainId?: number;
    name?: string;
    rpcUrl?: string;
    explorerUrl?: string;
  },
): string {
  const timestamp = new Date().toISOString();
  const defaultEntries = CONTRACT_EXPORTS.map((name) => {
    const value = contracts[name];
    if (!value) {
      throw new Error(`missing frontend contract address: ${name}`);
    }
    return `  ${name}: '${value}',`;
  });

  return `type ContractMap = Record<string, string>;

function pickDefined(records: Record<string, string | undefined>): ContractMap {
  return Object.entries(records).reduce<ContractMap>((acc, [key, value]) => {
    if (typeof value === 'string' && value.trim().length > 0) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

// 此文件由 frontend-config/scripts/generateBackendFrontendMigratedConfig.ts 自动生成。
// 历史兼容来源: ${sourceLabel}
// 当前正式生成链见 docs/Contract-Artifact-Generation-Guide.md。
// 生成时间: ${timestamp}
const GENERATED_DEFAULT_ADDRESSES = {
${defaultEntries.join('\n')}
} as const;

const ENV_CONTRACT_OVERRIDES = pickDefined({
  Registry: process.env.NEXT_PUBLIC_REGISTRY_ADDRESS || process.env.REGISTRY_ADDRESS,
  RegistryDynamicModuleKey:
    process.env.NEXT_PUBLIC_REGISTRY_DYNAMIC_MODULE_KEY_ADDRESS || process.env.REGISTRY_DYNAMIC_MODULE_KEY_ADDRESS,
  VaultCore: process.env.NEXT_PUBLIC_VAULT_CORE_ADDRESS || process.env.VAULT_CORE_ADDRESS,
  PositionView: process.env.NEXT_PUBLIC_POSITION_VIEW_ADDRESS || process.env.POSITION_VIEW_ADDRESS,
  DashboardView: process.env.NEXT_PUBLIC_DASHBOARD_VIEW_ADDRESS || process.env.DASHBOARD_VIEW_ADDRESS,
  UserView: process.env.NEXT_PUBLIC_USER_VIEW_ADDRESS || process.env.USER_VIEW_ADDRESS,
  RewardView: process.env.NEXT_PUBLIC_REWARD_VIEW_ADDRESS || process.env.REWARD_VIEW_ADDRESS,
  HealthView: process.env.NEXT_PUBLIC_HEALTH_VIEW_ADDRESS || process.env.HEALTH_VIEW_ADDRESS,
  CollateralManager: process.env.NEXT_PUBLIC_COLLATERAL_MANAGER_ADDRESS || process.env.COLLATERAL_MANAGER_ADDRESS,
  LendingEngine: process.env.NEXT_PUBLIC_LENDING_ENGINE_ADDRESS || process.env.LENDING_ENGINE_ADDRESS,
});

export const CONTRACT_ADDRESSES = {
  ...GENERATED_DEFAULT_ADDRESSES,
  ...ENV_CONTRACT_OVERRIDES,
  RegistryCore: ENV_CONTRACT_OVERRIDES.Registry || GENERATED_DEFAULT_ADDRESSES.Registry,
  VaultView: ENV_CONTRACT_OVERRIDES.PositionView || GENERATED_DEFAULT_ADDRESSES.PositionView,
  RewardRouter: ENV_CONTRACT_OVERRIDES.RewardView || GENERATED_DEFAULT_ADDRESSES.RewardView,
} as const;

export const NETWORK_CONFIG = {
  chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID || process.env.CHAIN_ID || ${Number(network?.chainId || 421614)}),
  name: process.env.NEXT_PUBLIC_CHAIN_NAME || process.env.CHAIN_NAME || '${network?.name || 'arbitrum-sepolia'}',
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || process.env.RPC_URL || '${network?.rpcUrl || 'https://sepolia-rollup.arbitrum.io/rpc'}',
  explorerUrl: process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL || process.env.BLOCK_EXPLORER_URL || '${network?.explorerUrl || 'https://sepolia.arbiscan.io'}',
  nativeCurrency: {
    name: 'Sepolia ETH',
    symbol: 'ETH',
    decimals: 18,
  },
};
`;
}

function main(): void {
  const moduleKeysPath = firstExistingPath([EXTERNAL_MODULE_KEYS_PATH, WORKSPACE_MODULE_KEYS_PATH]);
  if (!moduleKeysPath) {
    throw new Error('module keys artifact not found in external contracts repo or workspace frontend-config');
  }

  const contractsTsPath = firstExistingPath([EXTERNAL_CONTRACTS_PATH, WORKSPACE_CONTRACTS_PATH]);
  const deploymentManifestPath = firstExistingPath([EXTERNAL_DEPLOYMENT_MANIFEST_PATH]);

  const moduleKeyInputs = parseModuleKeyInputs(readFileStrict(moduleKeysPath));

  let contracts: Record<string, string>;
  let network: { chainId?: number; name?: string; rpcUrl?: string; explorerUrl?: string } | undefined;
  let contractsSourceLabel: string;

  if (contractsTsPath) {
    const tsSource = readFileStrict(contractsTsPath);
    contracts = parseContractAddresses(tsSource);
    network = parseNetworkConfigFromTs(tsSource);
    contractsSourceLabel = path.relative(ROOT, contractsTsPath);
  } else if (deploymentManifestPath) {
    const manifest = parseDeploymentManifest(readFileStrict(deploymentManifestPath));
    if (Object.keys(manifest.contracts).length === 0) {
      throw new Error('deployment manifest did not contain any contract addresses');
    }
    contracts = manifest.contracts;
    network = manifest.network;
    contractsSourceLabel = path.relative(ROOT, deploymentManifestPath);
  } else {
    throw new Error('contracts artifact not found in external contracts repo or workspace frontend-config');
  }

  fs.writeFileSync(BACKEND_MODULE_KEYS_PATH, buildBackendModuleKeys(moduleKeyInputs, path.relative(ROOT, moduleKeysPath)), 'utf8');
  fs.writeFileSync(BACKEND_CONTRACTS_PATH, buildBackendContracts(contracts, contractsSourceLabel, network), 'utf8');

  console.log(`generated ${path.relative(ROOT, BACKEND_MODULE_KEYS_PATH)}`);
  console.log(`generated ${path.relative(ROOT, BACKEND_CONTRACTS_PATH)}`);
}

main();