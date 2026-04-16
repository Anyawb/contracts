import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-reward-borrow-gate-rmcore').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
