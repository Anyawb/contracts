import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-fee-dynamic-gate').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
