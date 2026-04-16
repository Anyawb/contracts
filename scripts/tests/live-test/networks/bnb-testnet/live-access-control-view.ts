import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-access-control-view').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
