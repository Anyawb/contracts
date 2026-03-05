import { runCrossChainGovernanceGateVeto } from "../e2e/e2e-localhost-crosschaingov-gate-veto";

async function main() {
  await runCrossChainGovernanceGateVeto();
}

if (require.main === module) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exitCode = 1;
  });
}

