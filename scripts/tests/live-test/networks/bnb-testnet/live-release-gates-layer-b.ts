import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-release-gates-layer-b').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});