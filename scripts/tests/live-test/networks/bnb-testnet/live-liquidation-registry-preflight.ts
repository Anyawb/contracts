import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-liquidation-registry-preflight').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
