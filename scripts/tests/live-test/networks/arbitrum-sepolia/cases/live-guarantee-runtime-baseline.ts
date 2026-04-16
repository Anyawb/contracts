process.env.LIVE_GUARANTEE_BASELINE_LAYER = "runtime";

export const liveScriptPromise = import("./live-guarantee-baseline").then((mod) => mod.liveScriptPromise);