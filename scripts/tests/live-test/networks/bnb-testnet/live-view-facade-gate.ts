import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-view-facade-gate').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
