import "dotenv/config";
import { ethers, network } from "hardhat";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { envStr, loadAddressMap, resolveAddress } from "../tests/_addressResolver";

function key(name: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

const INVALID_ORDER_SELECTOR = ethers.id("LendingEngine__InvalidOrder()").slice(0, 10).toLowerCase();

function extractErrorSelector(reason?: string) {
  if (!reason) return "";
  const matched = reason.match(/0x[0-9a-fA-F]{8}/);
  return matched?.[0]?.toLowerCase() ?? "";
}

function isInvalidOrderProbeFailure(reason?: string) {
  const normalized = String(reason ?? "").toLowerCase();
  if (!normalized) return false;
  return normalized.includes("lendingengine__invalidorder")
    || normalized.includes("invalidorder")
    || extractErrorSelector(reason) === INVALID_ORDER_SELECTOR;
}

function classifyProbe(
  loanOrderProbe: { ok: boolean; reason?: string },
  totalDueProbe: { ok: boolean; reason?: string },
) {
  if (loanOrderProbe.ok && totalDueProbe.ok) {
    return "ok";
  }
  if (loanOrderProbe.ok && !totalDueProbe.ok) {
    return "SSOT_DEPLOYMENT_MISMATCH:ORDER_ENGINE_VIEW_ADAPTER_DIVERGENCE";
  }
  if (isInvalidOrderProbeFailure(loanOrderProbe.reason) && isInvalidOrderProbeFailure(totalDueProbe.reason)) {
    return "ORDER_ENGINE_PROBE_ORDER_UNAVAILABLE";
  }
  return "SSOT_DEPLOYMENT_MISMATCH:ORDER_ENGINE_SETTLEMENT_BRIDGE_BROKEN";
}

async function tryCallOrderEngineView(
  orderEngineAddr: string,
  settlementManagerAddr: string,
  fragment: string,
  functionName: string,
  args: readonly unknown[],
) {
  const iface = new ethers.Interface([fragment]);
  try {
    const raw = await ethers.provider.call({
      to: orderEngineAddr,
      from: settlementManagerAddr,
      data: iface.encodeFunctionData(functionName, args),
    });
    return { ok: true, rawPrefix: raw.slice(0, 14) } as const;
  } catch (error: any) {
    const reason = error?.shortMessage ?? error?.info?.error?.message ?? String(error?.message ?? error);
    return {
      ok: false,
      reason,
      selector: extractErrorSelector(reason),
      invalidOrder: isInvalidOrderProbeFailure(reason),
    } as const;
  }
}

async function main() {
  const orderId = BigInt(envStr("DEBUG_ORDER_ID") ?? "408");
  const artifactPath = path.resolve(process.cwd(), "artifacts/src/core/LendingEngine.sol/LendingEngine.json");
  const artifactJson = JSON.parse(readFileSync(artifactPath, "utf8")) as { deployedBytecode?: string };
  const localDeployedBytecode = String(artifactJson.deployedBytecode ?? "0x");

  const addressMap = loadAddressMap(network.name, { preferMockSuite: true });
  let registryAddr = "";
  try {
    registryAddr = resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });
  } catch {
    const deployOutput = envStr("DEPLOY_OUTPUT_FILE")
      ?? (network.name === "bnbTestnet" ? "scripts/deployments/bnb-testnet/core.json" : undefined);
    if (!deployOutput) {
      throw new Error("Missing Registry address. Set REGISTRY_ADDRESS or DEPLOY_OUTPUT_FILE.");
    }
    const deployOutputPath = path.isAbsolute(deployOutput)
      ? deployOutput
      : path.resolve(process.cwd(), deployOutput);
    if (!existsSync(deployOutputPath)) {
      throw new Error(`Missing deploy output file: ${deployOutputPath}`);
    }
    const parsed = JSON.parse(readFileSync(deployOutputPath, "utf8")) as Record<string, unknown>;
    const candidate = String(parsed.Registry ?? "").trim();
    if (!candidate || !ethers.isAddress(candidate)) {
      throw new Error(`Registry not found in deploy output: ${deployOutputPath}`);
    }
    registryAddr = candidate;
  }

  const registry = (await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    registryAddr,
  )) as any;

  const orderEngineAddr = String(await registry.getModuleOrRevert(key("ORDER_ENGINE")));
  const settlementManagerAddr = String(await registry.getModuleOrRevert(key("SETTLEMENT_MANAGER")));

  const proxyCode = await ethers.provider.getCode(orderEngineAddr);
  const implSlot = "0x360894A13BA1A3210667C828492DB98DCA3E2076CC3735A920A3CA505D382BBC";
  const adminSlot = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
  const implRaw = await ethers.provider.getStorage(orderEngineAddr, implSlot);
  const adminRaw = await ethers.provider.getStorage(orderEngineAddr, adminSlot);
  const implementationAddr = ethers.getAddress(`0x${implRaw.slice(-40)}`);
  const proxyAdminAddr = ethers.getAddress(`0x${adminRaw.slice(-40)}`);
  const implementationCode = await ethers.provider.getCode(implementationAddr);

  const loanProbe = await tryCallOrderEngineView(
    orderEngineAddr,
    settlementManagerAddr,
    "function getLoanOrderForView(uint256 orderId) view returns ((uint256 principal,uint256 rate,uint256 term,address borrower,address lender,address asset,uint256 startBlock,uint256 maturity,uint256 repaidAmount))",
    "getLoanOrderForView",
    [orderId],
  );
  const totalDueProbe = await tryCallOrderEngineView(
    orderEngineAddr,
    settlementManagerAddr,
    "function getOrderTotalDueForView(uint256 orderId) view returns (uint256)",
    "getOrderTotalDueForView",
    [orderId],
  );

  const probeClass = classifyProbe(loanProbe, totalDueProbe);

  const report = {
    network: network.name,
    registryAddr,
    orderEngineAddr,
    settlementManagerAddr,
    orderId: String(orderId),
    proxy: {
      runtimeCodeBytes: Math.max(0, (proxyCode.length - 2) / 2),
      runtimeCodeHash: ethers.keccak256(proxyCode),
      implementationAddr,
      adminAddr: proxyAdminAddr,
      looksLikeProxy: (proxyCode.length - 2) / 2 <= 400,
    },
    implementation: {
      runtimeCodeBytes: Math.max(0, (implementationCode.length - 2) / 2),
      runtimeCodeHash: ethers.keccak256(implementationCode),
    },
    localArtifact: {
      path: artifactPath,
      deployedBytecodeBytes: Math.max(0, (localDeployedBytecode.length - 2) / 2),
      deployedBytecodeHash: localDeployedBytecode === "0x" ? "0x" : ethers.keccak256(localDeployedBytecode),
      implementationHashMatchesArtifact: implementationCode !== "0x"
        && localDeployedBytecode !== "0x"
        && ethers.keccak256(implementationCode) === ethers.keccak256(localDeployedBytecode),
    },
    probes: {
      settlementToOrderEngine: {
        loanOrderForView: loanProbe,
        orderTotalDueForView: totalDueProbe,
        classification: probeClass,
      },
    },
  };

  console.log(JSON.stringify(report, null, 2));

  if (probeClass.startsWith("SSOT_DEPLOYMENT_MISMATCH:")) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
