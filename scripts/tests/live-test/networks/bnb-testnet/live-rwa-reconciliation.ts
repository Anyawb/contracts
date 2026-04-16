import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-rwa-reconciliation').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});