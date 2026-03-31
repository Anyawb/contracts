import fs from "fs";
import path from "path";
import { ethers, network } from "hardhat";

import { envStr, loadAddressMap, resolveAddress } from "../_addressResolver";
import { key } from "../live-test/_mockLiveUtils";

type AuditCheck = {
  label: string;
  account: string;
  anyOf: string[];
};

type AuditResult = {
  label: string;
  account: string;
  satisfied: boolean;
  matchedRole?: string;
  triedRoles: string[];
};

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

async function main() {
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
  const vblAddr = resolveAddress({
    name: "VaultBusinessLogic",
    map: addressMap,
  });
  const orderEngineAddr = resolveAddress({
    name: "LendingEngine",
    map: addressMap,
  });
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
    { label: "relayer LIQUIDATE", account: relayerAddr, anyOf: ["LIQUIDATE"] },
    { label: "relayer DEPOSIT", account: relayerAddr, anyOf: ["DEPOSIT"] },
    { label: "relayer VIEW_SYSTEM_DATA", account: relayerAddr, anyOf: ["VIEW_SYSTEM_DATA"] },
    { label: "relayer ACTION_VIEW_PUSH", account: relayerAddr, anyOf: ["ACTION_VIEW_PUSH"] },
    { label: "relayer UPDATE_PRICE", account: relayerAddr, anyOf: ["UPDATE_PRICE"] },
    { label: "relayer ACTION_ADMIN", account: relayerAddr, anyOf: ["ACTION_ADMIN"] },
    { label: "relayer SET_PARAMETER", account: relayerAddr, anyOf: ["SET_PARAMETER", "ACTION_SET_PARAMETER"] },
    { label: "relayer REWARD_CONFIG_EMERGENCY", account: relayerAddr, anyOf: ["ACTION_REWARD_CONFIG_EMERGENCY", "REWARD_CONFIG_EMERGENCY"] },
    { label: "SettlementManager REPAY", account: settlementManagerAddr, anyOf: ["REPAY"] },
    { label: "SettlementManager VIEW_SYSTEM_DATA", account: settlementManagerAddr, anyOf: ["VIEW_SYSTEM_DATA"] },
    { label: "SettlementManager LIQUIDATE", account: settlementManagerAddr, anyOf: ["LIQUIDATE"] },
    { label: "SettlementManager DEPOSIT", account: settlementManagerAddr, anyOf: ["DEPOSIT"] },
    { label: "VaultBusinessLogic ORDER_CREATE", account: vblAddr, anyOf: ["ORDER_CREATE"] },
    { label: "VaultBusinessLogic DEPOSIT", account: vblAddr, anyOf: ["DEPOSIT"] },
    { label: "LendingEngine BORROW", account: orderEngineAddr, anyOf: ["BORROW"] },
  ];

  const results = await auditRoleChecks(acm, checks);
  const missing = results.filter((result) => !result.satisfied);

  console.log("=== Live Role Readiness Audit ===");
  console.log(`network=${network.name}`);
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
}

main().catch((error) => {
  console.error("\n❌ live-role-readiness-audit FAILED\n");
  console.error(error);
  process.exit(1);
});