import { primeMockLiveViewCache } from "./_mockLiveViewCache";

// 单一职责脚本：仅预热 ViewCache，方便把系统级缓存先写热，
// 供后续 preflight / smoke / 观测脚本直接读取。
async function main() {
  await primeMockLiveViewCache({
    label: "Mock Live ViewCache Prime",
  });
}

main().catch((error) => {
  console.error("\n❌ live-prime-viewcache-arbitrum-sepolia FAILED\n");
  console.error(error);
  process.exit(1);
});