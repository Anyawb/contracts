import { network } from "hardhat";

import { createFundsFlowLiveContext } from "./_fundsFlowLive";
import { loadRewardModules, prepareRewardGovernanceCompatibility } from "./_rewardLive";

export type LiveDomain = "platform" | "fee" | "reward" | "guarantee";

type ExecutionBoundary = {
  executionMode: "live" | "fork-alias";
  logicalNetwork: string;
  physicalNetwork: string;
};

function resolveExecutionBoundary(): ExecutionBoundary {
  const alias = process.env.LIVE_NETWORK_ALIAS?.trim();
  const physicalNetwork = network.name;
  const isLocalRunner = physicalNetwork === "localhost" || physicalNetwork === "hardhat";

  if (isLocalRunner) {
    if (!alias) {
      throw new Error(
        `live-domain-preflight failed: ${physicalNetwork} requires explicit LIVE_NETWORK_ALIAS so live and fork boundaries cannot be mixed implicitly`,
      );
    }
    return {
      executionMode: "fork-alias",
      logicalNetwork: alias,
      physicalNetwork,
    };
  }

  if (alias && alias !== physicalNetwork) {
    throw new Error(
      `live-domain-preflight failed: LIVE_NETWORK_ALIAS=${alias} does not match active network ${physicalNetwork}`,
    );
  }

  return {
    executionMode: "live",
    logicalNetwork: physicalNetwork,
    physicalNetwork,
  };
}

function assertSupportedLogicalNetwork(logicalNetwork: string) {
  if (logicalNetwork === "bnbTestnet" || logicalNetwork === "arbitrumSepolia") {
    return;
  }
  throw new Error(
    `live-domain-preflight failed: unsupported logical network ${logicalNetwork}; choose an explicit live wrapper instead of relying on a fallback network mapping`,
  );
}

export async function runLiveDomainPreflight(domain: LiveDomain) {
  const boundary = resolveExecutionBoundary();
  assertSupportedLogicalNetwork(boundary.logicalNetwork);

  const ctx = await createFundsFlowLiveContext({
    label: `${domain}-domain-preflight`,
    collateralAmountUnitsDefault: "1",
    borrowAmountUnitsDefault: "1",
  });

  console.log(
    `=== Live Domain Preflight: ${domain} execution=${boundary.executionMode} logicalNetwork=${boundary.logicalNetwork} physicalNetwork=${boundary.physicalNetwork} registry=${ctx.registryAddr} ===`,
  );

  if (domain === "platform") {
    if (!ctx.settlementManagerAddr || ctx.settlementManagerAddr === "0x0000000000000000000000000000000000000000") {
      throw new Error(`platform-preflight failed: missing SettlementManager on ${boundary.logicalNetwork}`);
    }
    return;
  }

  if (domain === "fee") {
    if (!ctx.feeRouterAddr || ctx.feeRouterAddr === "0x0000000000000000000000000000000000000000") {
      throw new Error(`fee-preflight failed: missing FeeRouter on ${boundary.logicalNetwork}`);
    }
    if (!ctx.feeRouterView) {
      throw new Error(`fee-preflight failed: missing FeeRouterView on ${boundary.logicalNetwork}`);
    }
    return;
  }

  if (domain === "guarantee") {
    if (!ctx.guaranteeFundAddr || ctx.guaranteeFundAddr === "0x0000000000000000000000000000000000000000") {
      throw new Error(`guarantee-preflight failed: missing GuaranteeFundManager on ${boundary.logicalNetwork}`);
    }
    if (!ctx.ergmAddr || ctx.ergmAddr === "0x0000000000000000000000000000000000000000") {
      throw new Error(`guarantee-preflight failed: missing EarlyRepaymentGuaranteeManager on ${boundary.logicalNetwork}`);
    }
    return;
  }

  const reward = await loadRewardModules(ctx);
  await prepareRewardGovernanceCompatibility(reward.easyEmissionConfig.target as string);
}