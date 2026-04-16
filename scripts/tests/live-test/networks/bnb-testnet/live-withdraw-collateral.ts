import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-withdraw-collateral').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
