import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-reward-observability-evidence').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});