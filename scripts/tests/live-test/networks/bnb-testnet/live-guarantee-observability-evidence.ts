import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-guarantee-observability-evidence').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});