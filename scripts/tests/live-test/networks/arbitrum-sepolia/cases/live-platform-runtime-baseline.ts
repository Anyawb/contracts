process.env.LIVE_PLATFORM_BASELINE_LAYER = "runtime";

export const liveScriptPromise = import("./live-platform-baseline").then((mod) => mod.liveScriptPromise);