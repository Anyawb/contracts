import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-reward-runtime-baseline').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});