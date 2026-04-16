import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-view-consistency-gate').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
