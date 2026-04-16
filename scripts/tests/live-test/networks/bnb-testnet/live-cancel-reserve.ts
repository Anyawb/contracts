import { runBnbSharedLiveScript } from './_run-shared';

void runBnbSharedLiveScript('../../live-cancel-reserve').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
