import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-blocks-only-liquidation').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
