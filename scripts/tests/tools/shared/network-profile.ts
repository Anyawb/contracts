import fs from 'fs';
import path from 'path';
import { getLiveTestProfile } from '../../../config/profiles';

function parseArgs(argv: string[]): { command: string; network: string } {
  const [command, ...rest] = argv;

  if (command !== 'env') {
    throw new Error('Usage: network-profile.ts env --network <network>');
  }

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--network' && rest[index + 1]) {
      return { command, network: rest[index + 1] };
    }
    if (token.startsWith('--network=')) {
      return { command, network: token.slice('--network='.length) };
    }
  }

  throw new Error('Missing --network <network>');
}

function maybeReadJson(filePath?: string): Record<string, unknown> | undefined {
  if (!filePath) {
    return undefined;
  }

  const absolutePath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(absolutePath)) {
    return undefined;
  }

  return JSON.parse(fs.readFileSync(absolutePath, 'utf8')) as Record<string, unknown>;
}

function shellExport(key: string, value: string | number | boolean): string {
  return `export ${key}=${JSON.stringify(String(value))}`;
}

function main(): void {
  const { network } = parseArgs(process.argv.slice(2));
  const profile = getLiveTestProfile(network);
  const deployOutput = maybeReadJson(profile.deployOutputFile);
  const mockAssets = maybeReadJson(profile.mockAssetsFile);

  const exports: Array<string | undefined> = [
    shellExport('LIVE_PROFILE_NETWORK', profile.networkKey),
    shellExport('LIVE_PROFILE_SLUG', profile.networkSlug),
    shellExport('LIVE_SWEEP_SCRIPT', profile.sweepScriptFile),
    shellExport('LIVE_SWEEP_NETWORK', profile.networkKey),
    shellExport('DEPLOY_OUTPUT_FILE', profile.deployOutputFile),
    shellExport('ASSETS_FILE', profile.assetsFile),
    profile.mockAssetsFile ? shellExport('MOCK_ASSET_PACK_OUTPUT', profile.mockAssetsFile) : undefined,
    shellExport('LIVE_USE_MOCK_ASSET_PACK', profile.liveUseMockAssetPack ? 1 : 0),
    shellExport('LIVE_PRICE_MODE', profile.livePriceMode),
    shellExport('ALLOW_LIQUIDATION_MANAGER_PAUSE', profile.allowLiquidationManagerPause ? 1 : 0),
    shellExport('ALLOW_DYNAMIC_FEE_WRITE', profile.allowDynamicFeeWrite ? 1 : 0),
    shellExport('LIVE_RUNNER_NETWORK_MAX_ATTEMPTS', profile.networkMaxAttempts),
    deployOutput?.Registry ? shellExport('REGISTRY_ADDRESS', String(deployOutput.Registry)) : undefined,
    mockAssets?.settlementToken
      ? shellExport('SETTLEMENT_TOKEN_ADDRESS', String(mockAssets.settlementToken))
      : undefined,
    mockAssets?.settlementTokenDecimals
      ? shellExport('SETTLEMENT_TOKEN_DECIMALS', String(mockAssets.settlementTokenDecimals))
      : mockAssets?.settlementTokenMeta && typeof mockAssets.settlementTokenMeta === 'object' && 'decimals' in mockAssets.settlementTokenMeta
        ? shellExport(
            'SETTLEMENT_TOKEN_DECIMALS',
            String((mockAssets.settlementTokenMeta as { decimals?: number }).decimals ?? 6),
          )
        : undefined,
  ];

  process.stdout.write(`${exports.filter(Boolean).join('\n')}\n`);
}

main();
