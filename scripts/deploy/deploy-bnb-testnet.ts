/**
 * BNB Testnet 部署入口。
 * - 准备 BNB 专属 mock asset pack 与 settlement env
 * - 调用 BNB 专属 deploy core，避免复用 Arbitrum Sepolia 主体
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import hre from 'hardhat';
import { deployProfiles } from '../config/profiles';

type MockAssetPackOutput = {
  settlementToken: string;
  settlementTokenDecimals?: number;
  assets?: Array<{
    address: string;
    sourceId: string;
    decimals: number;
    settlementToken?: boolean;
  }>;
};

type BnbDeployProfile = (typeof deployProfiles)['bnbTestnet'];

function resolveGeneratedMockPackOutput(profile: BnbDeployProfile): string {
  const explicit = process.env.MOCK_ASSET_PACK_OUTPUT?.trim();
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.join(process.cwd(), explicit);
  }

  return path.join(process.cwd(), profile.outputs.generatedMockAssetPackFile ?? '');
}

function resolveGeneratedAssetsOutput(profile: BnbDeployProfile): string {
  const explicit = process.env.ASSETS_FILE?.trim();
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.join(process.cwd(), explicit);
  }

  return path.join(process.cwd(), profile.outputs.generatedAssetsFile ?? '');
}

function loadMockAssetPack(profile: BnbDeployProfile): MockAssetPackOutput {
  const outputFile = resolveGeneratedMockPackOutput(profile);
  const assetsOutputFile = resolveGeneratedAssetsOutput(profile);
  if (!fs.existsSync(outputFile) || process.env.BNB_REFRESH_MOCK_ASSETS === '1') {
    const result = spawnSync(
      'pnpm',
      ['-s', 'exec', 'hardhat', 'run', 'scripts/deploy/deploy-mock-asset-pack.ts', '--network', profile.networkKey],
      {
        cwd: process.cwd(),
        stdio: 'inherit',
        env: {
          ...process.env,
          MOCK_ASSET_PACK_FILE: profile.inputs.mockAssetPackSpecFile,
          MOCK_ASSET_PACK_OUTPUT: outputFile,
          ASSETS_FILE: assetsOutputFile,
        },
      },
    );

    if (result.status !== 0) {
      throw new Error(`BNB mock asset pack bootstrap failed with exit code ${result.status ?? 1}`);
    }
  }

  return JSON.parse(fs.readFileSync(outputFile, 'utf8')) as MockAssetPackOutput;
}

async function main(): Promise<void> {
  const profile = deployProfiles.bnbTestnet;
  const rpcUrl =
    process.env.BNB_TESTNET_RPC_URL ||
    process.env.BSC_TESTNET_RPC_URL ||
    process.env.BNB_TESTNET_URL ||
    process.env.BSC_TESTNET_URL ||
    '';

  if (hre.network.name !== profile.networkKey) {
    throw new Error(`Expected network ${profile.networkKey}, received ${hre.network.name}`);
  }

  if (!rpcUrl) {
    throw new Error('Missing BNB testnet RPC URL. Set BNB_TESTNET_RPC_URL or BSC_TESTNET_RPC_URL before deploy.');
  }

  const mockPack = loadMockAssetPack(profile);
  const settlementAsset = mockPack.assets?.find((asset) => asset.settlementToken)
    ?? mockPack.assets?.find((asset) => asset.address.toLowerCase() === mockPack.settlementToken.toLowerCase());

  if (!settlementAsset) {
    throw new Error('BNB mock asset pack has no settlement token entry.');
  }

  process.env.BNB_TESTNET_RPC_URL = rpcUrl;
  process.env.DEPLOY_PRODUCTION_STYLE = process.env.DEPLOY_PRODUCTION_STYLE || '1';
  process.env.DEPLOY_STRICT_ASSET_CONFIG = process.env.DEPLOY_STRICT_ASSET_CONFIG || '1';
  process.env.DEPLOY_ASSERT_PRICE_UPDATER = process.env.DEPLOY_ASSERT_PRICE_UPDATER || '1';
  process.env.DEPLOY_OUTPUT_FILE = profile.outputs.coreDeployFile;
  process.env.ASSETS_FILE = process.env.ASSETS_FILE || resolveGeneratedAssetsOutput(profile);
  process.env.MOCK_ASSET_PACK_OUTPUT = process.env.MOCK_ASSET_PACK_OUTPUT || resolveGeneratedMockPackOutput(profile);
  process.env.SETTLEMENT_TOKEN_ADDRESS = settlementAsset.address;
  process.env.SETTLEMENT_TOKEN_DECIMALS = String(
    mockPack.settlementTokenDecimals ?? settlementAsset.decimals,
  );
  process.env.SETTLEMENT_TOKEN_SOURCE_ID = settlementAsset.sourceId;

  await import('./deploy-bnb-testnet-core');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});