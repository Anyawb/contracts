import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-fee-config-governance').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});