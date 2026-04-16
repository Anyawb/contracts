import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { ethers, network, upgrades } from "hardhat";

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894A13BA1A3210667C828492DB98DCA3E2076CC3735A920A3CA505D382BBC";

type DeployMap = Record<string, string>;

type ProbeResult = {
  ok: boolean;
  reason?: string;
};

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

function classifyProbe(loanOrderProbe: ProbeResult, totalDueProbe: ProbeResult) {
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

function resolveDeployFile() {
  const explicit = process.env.DEPLOY_OUTPUT_FILE?.trim();
  if (!explicit) {
    return path.resolve(process.cwd(), "scripts/deployments/bnb-testnet/core.json");
  }
  return path.isAbsolute(explicit) ? explicit : path.resolve(process.cwd(), explicit);
}

function loadDeployMap(deployFile: string): DeployMap {
  if (!fs.existsSync(deployFile)) {
    throw new Error(`Deploy output file not found: ${deployFile}`);
  }
  return JSON.parse(fs.readFileSync(deployFile, "utf8")) as DeployMap;
}

function saveDeployMap(deployFile: string, map: DeployMap) {
  fs.mkdirSync(path.dirname(deployFile), { recursive: true });
  fs.writeFileSync(deployFile, JSON.stringify(map, null, 2));
}

async function getImplementationAddress(proxyAddr: string) {
  const raw = await ethers.provider.getStorage(proxyAddr, EIP1967_IMPLEMENTATION_SLOT);
  if (!raw || raw === "0x") return ethers.ZeroAddress;
  return ethers.getAddress(`0x${raw.slice(26)}`);
}

async function getCodeHash(addr: string) {
  const code = await ethers.provider.getCode(addr);
  if (!code || code === "0x") {
    return { hash: "0x", bytes: 0 };
  }
  return { hash: ethers.keccak256(code), bytes: (code.length - 2) / 2 };
}

async function tryCallOrderEngineView(
  orderEngineAddr: string,
  settlementManagerAddr: string,
  fragment: string,
  functionName: string,
  args: readonly unknown[],
): Promise<ProbeResult> {
  const iface = new ethers.Interface([fragment]);
  try {
    await ethers.provider.call({
      to: orderEngineAddr,
      from: settlementManagerAddr,
      data: iface.encodeFunctionData(functionName, args),
    });
    return { ok: true };
  } catch (error: any) {
    const reason = error?.shortMessage ?? error?.info?.error?.message ?? String(error?.message ?? error);
    return {
      ok: false,
      reason,
    };
  }
}

async function main() {
  if (network.name !== "bnbTestnet") {
    throw new Error(`Expected network bnbTestnet, got ${network.name}`);
  }

  const deployFile = resolveDeployFile();
  const deployed = loadDeployMap(deployFile);
  const artifactPath = path.resolve(process.cwd(), "artifacts/src/core/LendingEngine.sol/LendingEngine.json");
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Missing artifact: ${artifactPath}. Run compile first.`);
  }
  const artifactJson = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as { deployedBytecode?: string };
  const localDeployedBytecode = String(artifactJson.deployedBytecode ?? "0x");
  const localHash = localDeployedBytecode === "0x" ? "0x" : ethers.keccak256(localDeployedBytecode);

  const registryAddr = deployed.Registry;
  if (!registryAddr || !ethers.isAddress(registryAddr)) {
    throw new Error("Missing valid Registry address in deploy output.");
  }

  const registry = (await ethers.getContractAt(
    [
      "function getModuleOrRevert(bytes32) view returns (address)",
      "function setModule(bytes32,address)",
    ],
    registryAddr,
  )) as any;

  const registryOrderEngineAddr = ethers.getAddress(String(await registry.getModuleOrRevert(key("ORDER_ENGINE"))));
  const registrySettlementManagerAddr = ethers.getAddress(
    String(await registry.getModuleOrRevert(key("SETTLEMENT_MANAGER"))),
  );
  const deployOutputOrderEngineAddr = deployed.LendingEngine ? ethers.getAddress(deployed.LendingEngine) : undefined;
  const deployOutputSettlementManagerAddr = deployed.SettlementManager
    ? ethers.getAddress(deployed.SettlementManager)
    : undefined;

  console.log("[repair] registry ORDER_ENGINE:", registryOrderEngineAddr);
  if (deployOutputOrderEngineAddr) {
    console.log("[repair] deploy output LendingEngine:", deployOutputOrderEngineAddr);
  }
  console.log("[repair] registry SETTLEMENT_MANAGER:", registrySettlementManagerAddr);
  if (deployOutputSettlementManagerAddr) {
    console.log("[repair] deploy output SettlementManager:", deployOutputSettlementManagerAddr);
  }

  // Live chain truth source is Registry route. Align deploy output to avoid future drift.
  if (!deployOutputOrderEngineAddr || deployOutputOrderEngineAddr.toLowerCase() !== registryOrderEngineAddr.toLowerCase()) {
    deployed.LendingEngine = registryOrderEngineAddr;
    saveDeployMap(deployFile, deployed);
    console.log("[repair] aligned deploy output LendingEngine -> registry ORDER_ENGINE");
  }
  if (
    !deployOutputSettlementManagerAddr
    || deployOutputSettlementManagerAddr.toLowerCase() !== registrySettlementManagerAddr.toLowerCase()
  ) {
    deployed.SettlementManager = registrySettlementManagerAddr;
    saveDeployMap(deployFile, deployed);
    console.log("[repair] aligned deploy output SettlementManager -> registry SETTLEMENT_MANAGER");
  }

  const proxyAddr = registryOrderEngineAddr;
  const beforeImpl = await getImplementationAddress(proxyAddr);
  if (!beforeImpl || beforeImpl === ethers.ZeroAddress) {
    throw new Error(`ORDER_ENGINE at ${proxyAddr} is not an EIP-1967 proxy (implementation is zero).`);
  }

  const implBeforeHash = await getCodeHash(beforeImpl);
  console.log("[repair] implementation before:", beforeImpl, implBeforeHash);
  console.log("[repair] local artifact hash:", localHash);

  const forceUpgrade = process.env.FORCE_ORDER_ENGINE_UPGRADE === "1";
  const hashMismatch = localHash !== "0x" && implBeforeHash.hash !== localHash;
  if (hashMismatch || forceUpgrade) {
    console.log(
      `[repair] upgrading ORDER_ENGINE proxy ${proxyAddr} (reason=${hashMismatch ? "hash-mismatch" : "force-upgrade"})...`,
    );
    const f = await ethers.getContractFactory("LendingEngine");
    const upgraded = await upgrades.upgradeProxy(proxyAddr, f, { kind: "uups", unsafeAllow: ["constructor"] });
    await upgraded.waitForDeployment();

    const afterProxy = ethers.getAddress(await upgraded.getAddress());
    if (afterProxy.toLowerCase() !== proxyAddr.toLowerCase()) {
      throw new Error(`Upgrade changed proxy address unexpectedly: expected ${proxyAddr}, got ${afterProxy}`);
    }

    const afterImpl = await getImplementationAddress(proxyAddr);
    if (!afterImpl || afterImpl === ethers.ZeroAddress) {
      throw new Error("Upgraded ORDER_ENGINE implementation became zero address.");
    }

    const implAfterHash = await getCodeHash(afterImpl);
    console.log("[repair] implementation after:", afterImpl, implAfterHash);

    if (localHash !== "0x" && implAfterHash.hash !== localHash) {
      console.warn(
        `[repair] WARN implementation hash differs from local artifact after upgrade (expected=${localHash}, actual=${implAfterHash.hash}). Continuing with live bridge probe as source of truth.`,
      );
    }
  } else {
    console.log("[repair] ORDER_ENGINE implementation already matches local artifact; skip upgrade.");
  }

  const shouldUpgradeSettlementManager = process.env.SKIP_SETTLEMENT_MANAGER_UPGRADE !== "1";
  if (shouldUpgradeSettlementManager) {
    console.log(`[repair] upgrading SETTLEMENT_MANAGER proxy ${registrySettlementManagerAddr}...`);
    const settlementFactory = await ethers.getContractFactory("SettlementManager");
    const settlementUpgraded = await upgrades.upgradeProxy(registrySettlementManagerAddr, settlementFactory, {
      kind: "uups",
      unsafeAllow: ["constructor"],
    });
    await settlementUpgraded.waitForDeployment();
    const upgradedSettlementProxy = ethers.getAddress(await settlementUpgraded.getAddress());
    if (upgradedSettlementProxy.toLowerCase() !== registrySettlementManagerAddr.toLowerCase()) {
      throw new Error(
        `SettlementManager upgrade changed proxy address unexpectedly: expected ${registrySettlementManagerAddr}, got ${upgradedSettlementProxy}`,
      );
    }
    const settlementImpl = await getImplementationAddress(registrySettlementManagerAddr);
    const settlementImplHash = await getCodeHash(settlementImpl);
    console.log("[repair] settlementManager implementation:", settlementImpl, settlementImplHash);
  } else {
    console.log("[repair] skip SettlementManager upgrade because SKIP_SETTLEMENT_MANAGER_UPGRADE=1");
  }

  // Hard ensure Registry route consistency.
  const reboundOrderEngine = ethers.getAddress(String(await registry.getModuleOrRevert(key("ORDER_ENGINE"))));
  if (reboundOrderEngine.toLowerCase() !== proxyAddr.toLowerCase()) {
    await (await registry.setModule(key("ORDER_ENGINE"), proxyAddr)).wait();
  }
  const finalOrderEngine = ethers.getAddress(String(await registry.getModuleOrRevert(key("ORDER_ENGINE"))));
  if (finalOrderEngine.toLowerCase() !== proxyAddr.toLowerCase()) {
    throw new Error(`Registry ORDER_ENGINE route mismatch after repair: ${finalOrderEngine} != ${proxyAddr}`);
  }
  const reboundSettlementManager = ethers.getAddress(
    String(await registry.getModuleOrRevert(key("SETTLEMENT_MANAGER"))),
  );
  if (reboundSettlementManager.toLowerCase() !== registrySettlementManagerAddr.toLowerCase()) {
    await (await registry.setModule(key("SETTLEMENT_MANAGER"), registrySettlementManagerAddr)).wait();
  }
  const finalSettlementManager = ethers.getAddress(
    String(await registry.getModuleOrRevert(key("SETTLEMENT_MANAGER"))),
  );
  if (finalSettlementManager.toLowerCase() !== registrySettlementManagerAddr.toLowerCase()) {
    throw new Error(
      `Registry SETTLEMENT_MANAGER route mismatch after repair: ${finalSettlementManager} != ${registrySettlementManagerAddr}`,
    );
  }

  // SettlementManager bridge probe for live SSOT path.
  const settlementManagerAddr = finalSettlementManager;
  const probeOrderId = BigInt(process.env.DEBUG_ORDER_ID?.trim() || "408");

  const loanProbe = await tryCallOrderEngineView(
    proxyAddr,
    settlementManagerAddr,
    "function getLoanOrderForView(uint256 orderId) view returns ((uint256 principal,uint256 rate,uint256 term,address borrower,address lender,address asset,uint256 startBlock,uint256 maturity,uint256 repaidAmount))",
    "getLoanOrderForView",
    [probeOrderId],
  );
  const totalDueProbe = await tryCallOrderEngineView(
    proxyAddr,
    settlementManagerAddr,
    "function getOrderTotalDueForView(uint256 orderId) view returns (uint256)",
    "getOrderTotalDueForView",
    [probeOrderId],
  );

  const classification = classifyProbe(loanProbe, totalDueProbe);

  const report = {
    network: network.name,
    registry: registryAddr,
    orderEngineProxy: proxyAddr,
    settlementManager: settlementManagerAddr,
    probeOrderId: String(probeOrderId),
    probes: {
      loanOrderForView: loanProbe,
      orderTotalDueForView: totalDueProbe,
      classification,
    },
  };

  console.log(JSON.stringify(report, null, 2));

  if (classification !== "ok") {
    throw new Error(`ORDER_ENGINE bridge probe failed after repair: ${classification}`);
  }

  console.log("[repair] ORDER_ENGINE deployment-side repair completed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
