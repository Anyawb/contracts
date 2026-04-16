import { runBnbSharedLiveScript } from './_run-shared';

process.env.LIVE_RELEASE_NETWORK = process.env.LIVE_RELEASE_NETWORK || 'bnbTestnet';
process.env.LIVE_RELEASE_SCRIPT_NETWORK = process.env.LIVE_RELEASE_SCRIPT_NETWORK || 'bnbTestnet';

void runBnbSharedLiveScript('../../live-release-gates').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
