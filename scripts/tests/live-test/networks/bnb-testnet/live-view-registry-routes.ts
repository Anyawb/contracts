import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-view-registry-routes').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
