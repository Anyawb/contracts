import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-guarantee-baseline').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});