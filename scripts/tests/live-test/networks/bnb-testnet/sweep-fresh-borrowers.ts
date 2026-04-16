import hre from 'hardhat';
import { liveTestProfiles } from '../../../../config/profiles';

async function main(): Promise<void> {
  const profile = liveTestProfiles.bnbTestnet;
  const usingLocalForkAlias =
    process.env.BNB_LIVE_ALLOW_LOCAL_FORK === '1' && (hre.network.name === 'localhost' || hre.network.name === 'hardhat');
  if (hre.network.name !== 'bnbTestnet' && !usingLocalForkAlias) {
    throw new Error(`Expected network bnbTestnet, received ${hre.network.name}`);
  }

  process.env.MOCK_ASSET_PACK_OUTPUT =
    process.env.MOCK_ASSET_PACK_OUTPUT || profile.mockAssetsFile;

  const shared = await import('./cases/sweep-fresh-borrowers');
  await shared.liveScriptPromise;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
