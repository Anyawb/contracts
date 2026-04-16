import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-guarantee-runtime-baseline').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});