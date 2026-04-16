import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-liquidation-fallback').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
