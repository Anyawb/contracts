const layerBDefaults: Record<string, string> = {
  LIVE_STRICT_BLOCKS_ONLY_DATAPUSH: "1",
  LIVE_STRICT_BLOCKS_ONLY_PREMATURITY: "1",
  LIVE_BLOCKS_ONLY_PREMATURITY_POLL_ATTEMPTS: "6",
  LIVE_BLOCKS_ONLY_PREMATURITY_POLL_MS: "1200",
};

for (const [key, value] of Object.entries(layerBDefaults)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

export const liveScriptPromise = (async () => {
  const mod = await import("./live-blocks-only-liquidation");
  await mod.liveScriptPromise;
})();
