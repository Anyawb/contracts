import { primeMockLiveViewCache } from "../core/_mockLiveViewCache";
import { logLiveScriptFailure, logLiveScriptSuccess } from "../core/_scriptStatus";

// 单一职责脚本：仅预热 ViewCache，方便把系统级缓存先写热，
// 供后续 preflight / smoke / 观测脚本直接读取。
async function main() {
  await primeMockLiveViewCache({
    label: "Mock Live ViewCache Prime",
  });

  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = main().catch((error) => {
  logLiveScriptFailure(__filename, error);
  process.exit(1);
});