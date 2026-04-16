import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-reward-multi-borrower-stress').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
