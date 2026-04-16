import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-guarantee-events-datapush').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
