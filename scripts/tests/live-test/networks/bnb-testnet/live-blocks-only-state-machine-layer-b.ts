import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-blocks-only-state-machine-layer-b').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
