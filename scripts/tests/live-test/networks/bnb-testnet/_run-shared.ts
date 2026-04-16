import { prepareBnbLiveEnv } from './_bootstrap';

type RunBnbSharedLiveScriptOptions = {
  enableWarmupDefaults?: boolean;
  enablePreflightDefaults?: boolean;
};

export async function runBnbSharedLiveScript(
  sharedScriptPath: string,
  options: RunBnbSharedLiveScriptOptions = { enableWarmupDefaults: true },
): Promise<void> {
  prepareBnbLiveEnv(options);
  const localPath = sharedScriptPath.startsWith('../../')
    ? `./cases/${sharedScriptPath.slice(6)}`
    : sharedScriptPath;
  const mod = await import(localPath) as { liveScriptPromise?: Promise<void> };
  await mod.liveScriptPromise;
}
