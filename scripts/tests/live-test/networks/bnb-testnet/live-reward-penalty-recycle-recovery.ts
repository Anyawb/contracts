import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-reward-penalty-recycle-recovery').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
