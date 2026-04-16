import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-view-reward-loanflow-boundary').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
