import { runBlocksOnlyRolloutSmoke } from "./utils/blocks-only-rollout-smoke";

async function main() {
  await runBlocksOnlyRolloutSmoke({
    label: "Blocks-only localhost rollout smoke gate",
    artifactTag: "localhost-standalone",
    useSnapshot: true,
    writeArtifact: true,
    printSummary: true,
    strictRolePreflight: true,
    strictDataPushPayloads: true,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
