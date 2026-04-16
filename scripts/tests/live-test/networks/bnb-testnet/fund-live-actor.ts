import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../fund-live-actor').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
