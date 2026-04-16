import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-smoke-multi-stablecoin').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
