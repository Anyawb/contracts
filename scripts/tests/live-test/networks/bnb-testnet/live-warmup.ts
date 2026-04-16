import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-warmup').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
