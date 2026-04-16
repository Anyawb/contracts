import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-reward-config-governance').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
