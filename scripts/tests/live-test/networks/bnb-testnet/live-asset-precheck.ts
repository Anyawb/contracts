import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-asset-precheck').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
