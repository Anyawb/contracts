import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-lending-engine-view').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
