import { ethers, network } from "hardhat";

import { envStr } from "../tests/_addressResolver";

function key(name: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

const PRICE_UPDATER_REGISTRY_RAW_KEY = "COINGECKO_PRICE_UPDATER";

function displayKeyName(name: string) {
  if (name === PRICE_UPDATER_REGISTRY_RAW_KEY) {
    return "PRICE_UPDATER (compat raw: COINGECKO_PRICE_UPDATER)";
  }
  return name;
}

async function main() {
  if (network.name !== "arbitrumSepolia") {
    throw new Error(`expected --network arbitrumSepolia, got ${network.name}`);
  }

  const registryAddr = envStr("REGISTRY_ADDRESS");
  if (!registryAddr) {
    throw new Error("REGISTRY_ADDRESS is required");
  }

  const registry = (await ethers.getContractAt(
    [
      "function getModule(bytes32) view returns (address)",
      "function getModuleOrRevert(bytes32) view returns (address)",
    ],
    registryAddr,
  )) as any;

  const requiredKeys = [
    "SETTLEMENT_TOKEN",
    "ACCESS_CONTROL_MANAGER",
    "PRICE_ORACLE",
    "ASSET_WHITELIST",
    "FEE_ROUTER",
    "COLLATERAL_MANAGER",
    "VAULT_CORE",
    "VAULT_BUSINESS_LOGIC",
    "ORDER_ENGINE",
    "LENDER_POOL_VAULT",
    "VALUATION_ORACLE_VIEW",
    "VIEW_CACHE",
    "REWARD_VIEW",
    "HEALTH_VIEW",
    "POSITION_VIEW",
  ];

  const optionalKeys = [
    PRICE_UPDATER_REGISTRY_RAW_KEY,
    "GUARANTEE_FUND_MANAGER",
    "EARLY_REPAYMENT_GUARANTEE_MANAGER",
    "SETTLEMENT_MANAGER",
    "VAULT_STATISTICS",
    "LOAN_FLOW_VIEW",
    "FEE_ROUTER_VIEW",
    "SYSTEM_RISK_VIEW",
    "RISK_VIEW",
    "PREVIEW_VIEW",
    "USER_VIEW",
    "DASHBOARD_VIEW",
    "CACHE_OPTIMIZED_VIEW",
    "REGISTRY_VIEW",
    "BATCH_VIEW",
    "LOAN_NFT_VIEW",
    "MODULE_HEALTH_VIEW",
  ];

  console.log(`Registry=${registryAddr}`);
  console.log("\n[Required]");
  for (const name of requiredKeys) {
    try {
      const addr = (await registry.getModuleOrRevert(key(name))) as string;
      console.log(`${name}=${addr}`);
    } catch (error: any) {
      console.log(`${name}=<reverted:${error?.shortMessage ?? error?.message ?? String(error)}>`);
    }
  }

  console.log("\n[Optional]");
  for (const name of optionalKeys) {
    try {
      const addr = (await registry.getModule(key(name))) as string;
      console.log(`${displayKeyName(name)}=${addr}`);
    } catch (error: any) {
      console.log(`${displayKeyName(name)}=<reverted:${error?.shortMessage ?? error?.message ?? String(error)}>`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});