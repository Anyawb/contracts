import fs from "fs";
import path from "path";
import { ethers, network } from "hardhat";

import { envStr, loadAddressMap, resolveAddress } from "../_addressResolver";

type BorrowGateProbeResult = {
  label: string;
  passed: boolean;
  detail: string;
};

export type LiveRewardBorrowGateAuditResult = {
  networkName: string;
  registryAddr: string;
  relayerAddr: string;
  orderEngineAddr: string;
  rewardManagerCoreAddr: string;
  rewardViewAddr: string;
  lendingEngineAddr: string;
  probes: BorrowGateProbeResult[];
  failedProbes: BorrowGateProbeResult[];
};

const MISSING_ROLE_SELECTOR = ethers.id("MissingRole()").slice(0, 10).toLowerCase();

function key(name: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

function preferredAddressMap() {
  const explicit = envStr("DEPLOY_OUTPUT_FILE");
  if (explicit) {
    const resolved = path.isAbsolute(explicit)
      ? explicit
      : path.join(process.cwd(), explicit);
    if (!fs.existsSync(resolved)) {
      throw new Error(`DEPLOY_OUTPUT_FILE does not exist: ${resolved}`);
    }
    return JSON.parse(fs.readFileSync(resolved, "utf8")) as Record<string, string>;
  }
  return loadAddressMap(network.name, { preferMockSuite: true });
}

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

async function resolveRelayerAddress() {
  const preferred = envStr("RELAYER_ADDRESS") || envStr("KEEPER_ADDRESS");
  if (preferred) {
    return preferred;
  }
  const [signer] = await ethers.getSigners();
  return signer.address;
}

async function probeBorrowCheckCallerGate(params: {
  rewardManagerCoreAddr: string;
  relayerAddr: string;
  orderEngineAddr: string;
}) {
  const iface = new ethers.Interface([
    "function getUserLevelForBorrowCheck(address user) view returns (uint8)",
  ]);

  const probes: BorrowGateProbeResult[] = [];

  try {
    await ethers.provider.call({
      to: params.rewardManagerCoreAddr,
      from: params.relayerAddr,
      data: iface.encodeFunctionData("getUserLevelForBorrowCheck", [params.relayerAddr]),
    });
    probes.push({
      label: "EOA -> RMCore.getUserLevelForBorrowCheck should revert MissingRole",
      passed: false,
      detail: "call succeeded unexpectedly",
    });
  } catch (error: any) {
    const decoded = describeRevert(error);
    probes.push({
      label: "EOA -> RMCore.getUserLevelForBorrowCheck should revert MissingRole",
      passed: decoded.selector === MISSING_ROLE_SELECTOR,
      detail: decoded.decoded,
    });
  }

  if (network.name === "localhost" || network.name === "hardhat") {
    await ethers.provider.send("hardhat_impersonateAccount", [params.orderEngineAddr]);
    await ethers.provider.send("hardhat_setBalance", [params.orderEngineAddr, "0x56BC75E2D63100000"]);
    try {
      const oe = await ethers.getSigner(params.orderEngineAddr);
      await ethers.provider.call({
        to: params.rewardManagerCoreAddr,
        from: oe.address,
        data: iface.encodeFunctionData("getUserLevelForBorrowCheck", [params.relayerAddr]),
      });
      probes.push({
        label: "ORDER_ENGINE -> RMCore.getUserLevelForBorrowCheck should succeed",
        passed: true,
        detail: "call succeeded",
      });
    } catch (error: any) {
      const decoded = describeRevert(error);
      probes.push({
        label: "ORDER_ENGINE -> RMCore.getUserLevelForBorrowCheck should succeed",
        passed: false,
        detail: decoded.decoded,
      });
    } finally {
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [params.orderEngineAddr]);
    }
  } else {
    probes.push({
      label: "ORDER_ENGINE -> RMCore.getUserLevelForBorrowCheck should succeed",
      passed: true,
      detail: "skipped on non-local network (impersonation unavailable)",
    });
  }

  return probes;
}

async function probeRewardViewMirrorGate(params: {
  rewardViewAddr: string;
  relayerAddr: string;
}) {
  const iface = new ethers.Interface([
    "function getUserLevelForBorrowCheck(address user) view returns (uint8)",
  ]);

  try {
    await ethers.provider.call({
      to: params.rewardViewAddr,
      from: params.relayerAddr,
      data: iface.encodeFunctionData("getUserLevelForBorrowCheck", [params.relayerAddr]),
    });
    return {
      label: "RewardView USER_LEVEL mirror read-gate (EOA)",
      passed: false,
      detail: "call succeeded unexpectedly",
    } satisfies BorrowGateProbeResult;
  } catch (error: any) {
    const decoded = describeRevert(error);
    if (decoded.selector === "<empty>" && decoded.decoded.toLowerCase().includes("selector")) {
      return {
        label: "RewardView USER_LEVEL mirror read-gate (EOA)",
        passed: true,
        detail: "function not present on deployed RewardView (acceptable)",
      } satisfies BorrowGateProbeResult;
    }
    return {
      label: "RewardView USER_LEVEL mirror read-gate (EOA)",
      passed: decoded.selector === MISSING_ROLE_SELECTOR,
      detail: decoded.decoded,
    } satisfies BorrowGateProbeResult;
  }
}

export async function runLiveRewardBorrowGateAudit(): Promise<LiveRewardBorrowGateAuditResult> {
  const addressMap = preferredAddressMap();
  const registryAddr = envStr("REGISTRY_ADDRESS") || resolveAddress({
    name: "Registry",
    map: addressMap,
  });
  const relayerAddr = await resolveRelayerAddress();

  const registry = (await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    registryAddr,
  )) as any;

  const orderEngineAddr = String(await registry.getModuleOrRevert(key("ORDER_ENGINE")));
  const rewardManagerCoreAddr = String(await registry.getModuleOrRevert(key("REWARD_MANAGER_CORE")));
  const rewardViewAddr = String(await registry.getModuleOrRevert(key("REWARD_VIEW")));
  const lendingEngineAddr = String(await registry.getModuleOrRevert(key("LENDING_ENGINE")));

  const probes: BorrowGateProbeResult[] = [];
  probes.push(...(await probeBorrowCheckCallerGate({
    rewardManagerCoreAddr,
    relayerAddr,
    orderEngineAddr,
  })));
  probes.push(await probeRewardViewMirrorGate({ rewardViewAddr, relayerAddr }));

  const failedProbes = probes.filter((item) => !item.passed);
  const result: LiveRewardBorrowGateAuditResult = {
    networkName: network.name,
    registryAddr,
    relayerAddr,
    orderEngineAddr,
    rewardManagerCoreAddr,
    rewardViewAddr,
    lendingEngineAddr,
    probes,
    failedProbes,
  };

  console.log("=== Live Reward Borrow Gate Audit ===");
  console.log(`network=${result.networkName}`);
  console.log(`registry=${result.registryAddr}`);
  console.log(`relayer=${result.relayerAddr}`);
  console.log(`ORDER_ENGINE=${result.orderEngineAddr}`);
  console.log(`REWARD_MANAGER_CORE=${result.rewardManagerCoreAddr}`);
  console.log(`REWARD_VIEW=${result.rewardViewAddr}`);
  console.log(`LENDING_ENGINE=${result.lendingEngineAddr}`);
  console.log("\nCanonical BorrowCheck source: RewardManagerCore.getUserLevelForBorrowCheck (not RewardView mirror)");

  for (const probe of probes) {
    console.log(`${probe.passed ? "OK" : "FAILED"} ${probe.label} detail=${probe.detail}`);
  }

  if (failedProbes.length > 0) {
    throw new Error(
      `Live reward borrow-gate audit failed: ${failedProbes.map((item) => `${item.label}(${item.detail})`).join(", ")}`,
    );
  }

  return result;
}

async function main() {
  await runLiveRewardBorrowGateAudit();
}

if (require.main === module) {
  main().catch((error) => {
    console.error("\n❌ live-reward-borrow-gate-audit FAILED\n");
    console.error(error);
    process.exit(1);
  });
}
