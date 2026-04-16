import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-reward-baseline').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});