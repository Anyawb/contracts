import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-shortfall-ledger').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});