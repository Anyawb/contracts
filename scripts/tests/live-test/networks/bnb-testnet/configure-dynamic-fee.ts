import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../configure-dynamic-fee').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
