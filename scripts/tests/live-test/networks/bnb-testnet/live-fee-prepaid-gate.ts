import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-fee-prepaid-gate').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
