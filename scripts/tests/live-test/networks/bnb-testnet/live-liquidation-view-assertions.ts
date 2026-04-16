import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-liquidation-view-assertions').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
