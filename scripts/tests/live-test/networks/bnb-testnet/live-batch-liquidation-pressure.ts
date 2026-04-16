import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-batch-liquidation-pressure').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
