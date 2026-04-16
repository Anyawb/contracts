import { prepareBnbLiveEnv } from './_bootstrap';

async function main(): Promise<void> {
  prepareBnbLiveEnv({ enablePreflightDefaults: true });

  const mod = await import('./cases/live-preflight') as { liveScriptPromise?: Promise<void> };
  await mod.liveScriptPromise;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
