import { prepareBnbLiveEnv } from './_bootstrap';

async function main(): Promise<void> {
  prepareBnbLiveEnv({ enableWarmupDefaults: true });

  if ((process.env.BNB_SKIP_WARMUP ?? '0') !== '1') {
    const warmup = await import('./cases/live-warmup') as { liveScriptPromise?: Promise<void> };
    await warmup.liveScriptPromise;
  }

  const baseline = await import('./cases/live-platform-observability-evidence') as { liveScriptPromise?: Promise<void> };
  await baseline.liveScriptPromise;
}

export const liveScriptPromise = main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});