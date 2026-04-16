process.env.LIVE_GUARANTEE_BASELINE_LAYER = "observability";

export const liveScriptPromise = import("./live-guarantee-baseline").then((mod) => mod.liveScriptPromise);