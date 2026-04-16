async function main() {
  const modPath = "../e2e/e2e-localhost-crosschaingov-gate-veto";
  const mod = await import(modPath).catch(() => null);
  if (!mod || typeof mod.runCrossChainGovernanceGateVeto !== "function") {
    throw new Error("Missing e2e-localhost-crosschaingov-gate-veto script");
  }
  await mod.runCrossChainGovernanceGateVeto();
}

if (require.main === module) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exitCode = 1;
  });
}

