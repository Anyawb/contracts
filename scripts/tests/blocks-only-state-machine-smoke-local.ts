import { runBlocksOnlyRolloutSmoke } from "../e2e/utils/blocks-only-rollout-smoke";

async function main() {
  await runBlocksOnlyRolloutSmoke({
    label: "Blocks-only localhost state-machine smoke",
    artifactTag: "localhost-smoke",
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