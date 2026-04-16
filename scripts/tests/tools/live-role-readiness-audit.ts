import fs from "fs";
import path from "path";
import { ethers, network } from "hardhat";

import { envStr, loadAddressMap, resolveAddress } from "../_addressResolver";
import { key } from "../live-test/networks/bnb-testnet/core/_mockLiveUtils";

type AuditCheck = {
  label: string;
  account: string;
  anyOf: string[];
};

export type AuditResult = {
  label: string;
  account: string;
  satisfied: boolean;
  matchedRole?: string;
  triedRoles: string[];
};

export type BridgeProbeResult = {
  label: string;
  passed: boolean;
  detail: string;
};

export type LiveRoleReadinessAuditResult = {
  networkName: string;
  registryAddr: string;
  acmAddr: string;
  acmOwner: string;
  relayerAddr: string;
  settlementManagerAddr: string;
  orderEngineAddr: string;
  vaultBusinessLogicAddr: string;
  results: AuditResult[];
  missing: AuditResult[];
  bridgeResults: BridgeProbeResult[];
  failedBridgeChecks: BridgeProbeResult[];
};

const MISSING_ROLE_SELECTOR = ethers.id("MissingRole()").slice(0, 10).toLowerCase();

function extractRevertData(error: any): string | null {
  const candidates = [
    error?.data,
    error?.data?.data,
    error?.data?.result,
    error?.error?.data,
    error?.error?.data?.data,
    error?.error?.data?.result,
    error?.info?.error?.data,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.startsWith("0x")) {
      return candidate;
    }
  }
  return null;
}

function describeRevert(error: any): { selector: string; decoded: string } {
  const data = extractRevertData(error);
  if (!data || data === "0x") {
    return {
      selector: "<empty>",
      decoded: String(error?.shortMessage ?? error?.message ?? error),
    };
  }

  const selector = data.slice(0, 10).toLowerCase();
  if (selector === MISSING_ROLE_SELECTOR) {
    return { selector, decoded: "MissingRole()" };
  }
  if (selector === "0x08c379a0") {
    try {
      const [message] = ethers.AbiCoder.defaultAbiCoder().decode(["string"], `0x${data.slice(10)}`);
      return { selector, decoded: `Error(\"${message}\")` };
    } catch {
      return { selector, decoded: "Error(<decode-failed>)" };
    }
  }
  return { selector, decoded: `CustomError(${selector})` };
}

export async function probeSettlementManagerBridge(orderEngineAddr: string, settlementManagerAddr: string) {
  const iface = new ethers.Interface([
    "function getLoanOrderForView(uint256 orderId) view returns ((uint256,uint256,uint256,address,address,address,uint256,uint256,uint256))",
    "function getOrderTotalDueForView(uint256 orderId) view returns (uint256)",
    "function repay(uint256 orderId,uint256 repayAmount)",
  ]);
  const probes: Array<{ label: string; data: string }> = [
    {
      label: "SettlementManager->ORDER_ENGINE getLoanOrderForView bridge",
      data: iface.encodeFunctionData("getLoanOrderForView", [0n]),
    },
    {
      label: "SettlementManager->ORDER_ENGINE getOrderTotalDueForView bridge",
      data: iface.encodeFunctionData("getOrderTotalDueForView", [0n]),
    },
    {
      label: "SettlementManager->ORDER_ENGINE repay bridge",
      data: iface.encodeFunctionData("repay", [0n, 1n]),
    },
  ];

  const results: BridgeProbeResult[] = [];
  for (const probe of probes) {
    try {
      await ethers.provider.call({
        to: orderEngineAddr,
        from: settlementManagerAddr,
        data: probe.data,
      });
      results.push({
        label: probe.label,
        passed: true,
        detail: "call succeeded",
      });
    } catch (error: any) {
      const decoded = describeRevert(error);
      results.push({
        label: probe.label,
        passed: decoded.selector !== MISSING_ROLE_SELECTOR,
        detail: decoded.decoded,
      });
    }
  }

  return results;
}

function preferredAddressMap() {
  const explicit = envStr("DEPLOY_OUTPUT_FILE");
  if (explicit) {
    const candidate = path.isAbsolute(explicit) ? explicit : path.join(process.cwd(), explicit);
    if (fs.existsSync(candidate)) {
      return JSON.parse(fs.readFileSync(candidate, "utf8")) as Record<string, string>;
    }
  }
  return loadAddressMap(network.name, { preferMockSuite: true });
}

async function resolveRelayerAddress() {
  const signer = (await ethers.getSigners())[0];
  return signer.address;
}

async function auditRoleChecks(acm: any, checks: AuditCheck[]) {
  const results: AuditResult[] = [];

  for (const check of checks) {
    let matchedRole: string | undefined;
    for (const roleName of check.anyOf) {
      if ((await acm.hasRole(key(roleName), check.account)) as boolean) {
        matchedRole = roleName;
        break;
      }
    }
    results.push({
      label: check.label,
      account: check.account,
      satisfied: Boolean(matchedRole),
      matchedRole,
      triedRoles: check.anyOf,
    });
  }

  return results;
}

export async function runLiveRoleReadinessAudit(): Promise<LiveRoleReadinessAuditResult> {
  const addressMap = preferredAddressMap();
  const registryAddr = envStr("REGISTRY_ADDRESS") || resolveAddress({
    name: "Registry",
    map: addressMap,
  });
  const acmAddr = resolveAddress({
    name: "AccessControlManager",
    map: addressMap,
  });
  const settlementManagerAddr = resolveAddress({
    name: "SettlementManager",
    map: addressMap,
  });
  const registry = (await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    registryAddr,
  )) as any;
  const vblAddr = resolveAddress({
    name: "VaultBusinessLogic",
    map: addressMap,
  });
  const orderEngineAddr = String(await registry.getModuleOrRevert(key("ORDER_ENGINE")));
  const relayerAddr = await resolveRelayerAddress();

  const acm = (await ethers.getContractAt(
    [
      "function owner() view returns (address)",
      "function hasRole(bytes32 role,address account) view returns (bool)",
    ],
    acmAddr,
  )) as any;

  const owner = String(await acm.owner());
  const checks: AuditCheck[] = [
    { label: "relayer VIEW_PRICE_DATA", account: relayerAddr, anyOf: ["VIEW_PRICE_DATA"] },
    { label: "relayer VIEW_USER_DATA", account: relayerAddr, anyOf: ["VIEW_USER_DATA"] },
    { label: "relayer VIEW_RISK_DATA", account: relayerAddr, anyOf: ["VIEW_RISK_DATA"] },
    { label: "relayer LIQUIDATE", account: relayerAddr, anyOf: ["LIQUIDATE"] },
    { label: "relayer DEPOSIT", account: relayerAddr, anyOf: ["DEPOSIT"] },
    { label: "relayer VIEW_SYSTEM_DATA", account: relayerAddr, anyOf: ["VIEW_SYSTEM_DATA"] },
    { label: "relayer ACTION_VIEW_PUSH", account: relayerAddr, anyOf: ["ACTION_VIEW_PUSH"] },
    { label: "relayer UPDATE_PRICE", account: relayerAddr, anyOf: ["UPDATE_PRICE"] },
    { label: "relayer system viewer", account: relayerAddr, anyOf: ["ACTION_ADMIN", "ACTION_VIEW_SYSTEM_STATUS"] },
    { label: "relayer SET_PARAMETER", account: relayerAddr, anyOf: ["SET_PARAMETER", "ACTION_SET_PARAMETER"] },
    { label: "relayer REWARD_CONFIG_EMERGENCY", account: relayerAddr, anyOf: ["ACTION_REWARD_CONFIG_EMERGENCY", "REWARD_CONFIG_EMERGENCY"] },
    { label: "SettlementManager LIQUIDATE", account: settlementManagerAddr, anyOf: ["LIQUIDATE"] },
    { label: "SettlementManager VIEW_RISK_DATA", account: settlementManagerAddr, anyOf: ["VIEW_RISK_DATA"] },
    { label: "VaultBusinessLogic ORDER_CREATE", account: vblAddr, anyOf: ["ORDER_CREATE"] },
    { label: "VaultBusinessLogic DEPOSIT", account: vblAddr, anyOf: ["DEPOSIT"] },
    { label: "LendingEngine BORROW", account: orderEngineAddr, anyOf: ["BORROW"] },
  ];

  const results = await auditRoleChecks(acm, checks);
  const missing = results.filter((result) => !result.satisfied);
  const bridgeResults = await probeSettlementManagerBridge(orderEngineAddr, settlementManagerAddr);
  const failedBridgeChecks = bridgeResults.filter((result) => !result.passed);

  const auditResult: LiveRoleReadinessAuditResult = {
    networkName: network.name,
    registryAddr,
    acmAddr,
    acmOwner: owner,
    relayerAddr,
    settlementManagerAddr,
    orderEngineAddr,
    vaultBusinessLogicAddr: vblAddr,
    results,
    missing,
    bridgeResults,
    failedBridgeChecks,
  };

  console.log("=== Live Role Readiness Audit ===");
  console.log(`network=${auditResult.networkName}`);
  console.log(`registry=${registryAddr}`);
  console.log(`acm=${acmAddr}`);
  console.log(`acmOwner=${owner}`);
  console.log(`relayer=${relayerAddr}`);

  console.log("\n=== Role Matrix ===");
  for (const result of results) {
    const status = result.satisfied ? "OK" : "MISSING";
    const detail = result.satisfied
      ? `matched=${result.matchedRole}`
      : `requiredAnyOf=${result.triedRoles.join("|")}`;
    console.log(`${status} ${result.label} account=${result.account} ${detail}`);
  }

  console.log("\n=== Missing Role Summary ===");
  if (missing.length === 0) {
    console.log("none");
  } else {
    for (const result of missing) {
      console.log(`- ${result.label} account=${result.account} requiredAnyOf=${result.triedRoles.join("|")}`);
    }
  }

  console.log("\n=== SettlementManager Bridge Probes ===");
  for (const result of bridgeResults) {
    console.log(`${result.passed ? "OK" : "FAILED"} ${result.label} detail=${result.detail}`);
  }

  if (failedBridgeChecks.length > 0) {
    throw new Error(
      `SettlementManager ORDER_ENGINE bridge checks failed: ${failedBridgeChecks
        .map((result) => `${result.label}(${result.detail})`)
        .join(", ")}`,
    );
  }

  return auditResult;
}

async function main() {
  await runLiveRoleReadinessAudit();
}

if (require.main === module) {
  main().catch((error) => {
    console.error("\n❌ live-role-readiness-audit FAILED\n");
    console.error(error);
    process.exit(1);
  });
}