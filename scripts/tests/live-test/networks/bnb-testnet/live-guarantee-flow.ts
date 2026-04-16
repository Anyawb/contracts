import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-guarantee-flow').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
