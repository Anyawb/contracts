import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-view-facade-consistency').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
