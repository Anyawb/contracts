import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-fee-baseline').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});