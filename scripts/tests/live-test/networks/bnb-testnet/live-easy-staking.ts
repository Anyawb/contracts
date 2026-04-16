import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-easy-staking').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
