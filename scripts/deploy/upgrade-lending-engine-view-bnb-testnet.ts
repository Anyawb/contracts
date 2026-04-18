import fs from "node:fs";
import path from "node:path";
import hre, { ethers, upgrades, network } from "hardhat";

function key(name: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

function resolveCoreFile(): string {
  const explicit = process.env.DEPLOY_OUTPUT_FILE?.trim();
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.resolve(process.cwd(), explicit);
  }
  return path.resolve(process.cwd(), "scripts/deployments/bnb-testnet/core.json");
}

async function main() {
  if (network.name !== "bnbTestnet") {
    throw new Error(`expected --network bnbTestnet, got ${network.name}`);
  }

  const rpcUrl = process.env.BNB_TESTNET_RPC_URL?.trim()
    || process.env.BSC_TESTNET_RPC_URL?.trim()
    || process.env.BNB_TESTNET_URL?.trim()
    || process.env.BSC_TESTNET_URL?.trim();
  if (!rpcUrl) {
    throw new Error("Missing BNB RPC URL. Set BNB_TESTNET_RPC_URL or BSC_TESTNET_RPC_URL.");
  }

  const coreFile = resolveCoreFile();
  if (!fs.existsSync(coreFile)) {
    throw new Error(`core deploy output not found: ${coreFile}`);
  }

  const core = JSON.parse(fs.readFileSync(coreFile, "utf8")) as Record<string, string>;
  const registryAddr = String(core.Registry || "").trim();
  const proxyAddr = String(core.LendingEngineView || "").trim();
  if (!registryAddr || !ethers.isAddress(registryAddr)) {
    throw new Error(`invalid Registry address in ${coreFile}: ${registryAddr}`);
  }
  if (!proxyAddr || !ethers.isAddress(proxyAddr)) {
    throw new Error(`invalid LendingEngineView address in ${coreFile}: ${proxyAddr}`);
  }

  const registry = await ethers.getContractAt(
    ["function getModule(bytes32) view returns (address)", "function setModule(bytes32,address)"],
    registryAddr,
  ) as any;

  const registryViewAddr = String(await registry.getModule(key("LENDING_ENGINE_VIEW")));
  if (registryViewAddr.toLowerCase() !== proxyAddr.toLowerCase()) {
    throw new Error(`core/registry mismatch for LENDING_ENGINE_VIEW: core=${proxyAddr} registry=${registryViewAddr}`);
  }

  const beforeImpl = await upgrades.erc1967.getImplementationAddress(proxyAddr);
  const f = await ethers.getContractFactory("LendingEngineView");
  const upgraded = await upgrades.upgradeProxy(proxyAddr, f, {
    kind: "uups",
    unsafeAllow: ["constructor"],
  });
  await upgraded.waitForDeployment();

  const reboundProxy = await upgraded.getAddress();
  const afterImpl = await upgrades.erc1967.getImplementationAddress(reboundProxy);

  const registryAfter = String(await registry.getModule(key("LENDING_ENGINE_VIEW")));
  if (registryAfter.toLowerCase() !== reboundProxy.toLowerCase()) {
    await (await registry.setModule(key("LENDING_ENGINE_VIEW"), reboundProxy)).wait();
  }

  const ver = await ethers.getContractAt(
    [
      "function apiVersion() view returns (uint256)",
      "function schemaVersion() view returns (uint256)",
      "function getVersionInfo() view returns (uint256,uint256,address)",
    ],
    reboundProxy,
  ) as any;

  const [apiVersion, schemaVersion, versionImpl] = await ver.getVersionInfo();

  console.log(JSON.stringify({
    network: network.name,
    coreFile,
    registry: registryAddr,
    proxy: reboundProxy,
    implementationBefore: beforeImpl,
    implementationAfter: afterImpl,
    changed: beforeImpl.toLowerCase() !== afterImpl.toLowerCase(),
    apiVersion: apiVersion.toString(),
    schemaVersion: schemaVersion.toString(),
    implementationFromVersionInfo: String(versionImpl),
  }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
