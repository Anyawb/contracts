import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-ergm-settlement-entry-guard').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
