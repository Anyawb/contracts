import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-ops-extension-modules').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
