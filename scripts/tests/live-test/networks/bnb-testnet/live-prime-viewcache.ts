import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-prime-viewcache').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
