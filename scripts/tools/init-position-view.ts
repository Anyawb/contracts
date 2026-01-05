import { ethers } from "hardhat";

/**
 * Initialize PositionView after deployment and dump its dependencies.
 * Usage:
 *   REGISTRY_ADDR=0x... POSITION_VIEW_ADDR=0x... npx hardhat run --network localhost scripts/tools/init-position-view.ts
 */
async function main() {
  const registryAddr = process.env.REGISTRY_ADDR;
  const pvAddr = process.env.POSITION_VIEW_ADDR;

  if (!registryAddr || !pvAddr) {
    throw new Error("Please set REGISTRY_ADDR and POSITION_VIEW_ADDR environment variables.");
  }

  const registry = await ethers.getContractAt("Registry", registryAddr);
  const pv = await ethers.getContractAt("PositionView", pvAddr);

  const key = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
  const keys = {
    COLLATERAL_MANAGER: key("COLLATERAL_MANAGER"),
    LENDING_ENGINE: key("LENDING_ENGINE"),
    VAULT_CORE: key("VAULT_CORE"),
    VAULT_BUSINESS_LOGIC: key("VAULT_BUSINESS_LOGIC"),
    ACCESS_CONTROL_MANAGER: key("ACCESS_CONTROL_MANAGER"),
  };

  console.log("Registry:", registryAddr);
  for (const [name, k] of Object.entries(keys)) {
    const addr = await registry.getModule(k).catch(() => ethers.ZeroAddress);
    console.log(`${name}: ${addr}`);
  }

  // Try initialize if not yet set
  try {
    const regInPv = await pv.getRegistry().catch(() => ethers.ZeroAddress);
    console.log("PositionView.getRegistry() before init:", regInPv);
    if (regInPv === ethers.ZeroAddress) {
      console.log("Initializing PositionView...");
      await (await pv.initialize(registryAddr)).wait();
      const after = await pv.getRegistry();
      console.log("PositionView.getRegistry() after init:", after);
    } else {
      console.log("PositionView already initialized, skip.");
    }
  } catch (e) {
    console.log("⚠️ PositionView initialization failed:", e);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});





