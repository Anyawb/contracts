import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../seed-liquidatable-order').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
