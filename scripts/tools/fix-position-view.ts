import { ethers } from "hardhat";

/**
 * Fix PositionView by setting core module keys and initializing.
 * Usage:
 *   REGISTRY_ADDR=0x... POSITION_VIEW_ADDR=0x... \
 *   CM=0x... LE=0x... VAULT_CORE=0x... VBL=0x... ACM=0x... \
 *   npx hardhat run --network localhost scripts/tools/fix-position-view.ts
 */
async function main() {
  const registryAddr = process.env.REGISTRY_ADDR;
  const pvAddr = process.env.POSITION_VIEW_ADDR;
  if (!registryAddr || !pvAddr) throw new Error("REGISTRY_ADDR and POSITION_VIEW_ADDR required");

  const addr = (name: string) => {
    const val = process.env[name];
    if (!val) throw new Error(`Missing env ${name}`);
    return val;
  };

  const addrs = {
    COLLATERAL_MANAGER: addr("CM"),
    LENDING_ENGINE: addr("LE"),
    VAULT_CORE: addr("VAULT_CORE"),
    VAULT_BUSINESS_LOGIC: addr("VBL"),
    ACCESS_CONTROL_MANAGER: addr("ACM"),
  };

  const key = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
  const registry = await ethers.getContractAt("Registry", registryAddr);

  for (const [name, a] of Object.entries(addrs)) {
    const k = key(name);
    const before = await registry.getModule(k).catch(() => ethers.ZeroAddress);
    console.log("before", name, before);
    const tx = await registry.setModule(k, a);
    await tx.wait();
    const after = await registry.getModule(k);
    console.log("after ", name, after);
  }

  const pv = await ethers.getContractAt("PositionView", pvAddr);
  let regInPv = await pv.getRegistry().catch(() => ethers.ZeroAddress);
  console.log("PositionView.registry before init:", regInPv);
  if (regInPv === ethers.ZeroAddress) {
    const tx = await pv.initialize(registryAddr);
    await tx.wait();
    regInPv = await pv.getRegistry();
    console.log("PositionView.registry after init:", regInPv);
  } else {
    console.log("PositionView already initialized, skip.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});





