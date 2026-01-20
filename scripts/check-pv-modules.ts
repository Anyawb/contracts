import { ethers } from "hardhat";

async function main() {
  const registryAddr = process.env.REGISTRY_ADDR ?? "";
  const positionViewAddr = process.env.POSITION_VIEW_ADDR ?? "";
  if (!registryAddr || !positionViewAddr) {
    throw new Error("Please set REGISTRY_ADDR and POSITION_VIEW_ADDR env vars");
  }
  const registry = await ethers.getContractAt("Registry", registryAddr);
  const pv = await ethers.getContractAt("PositionView", positionViewAddr);

  const key = (name: string) => ethers.keccak256(ethers.toUtf8Bytes(name));
  const keys = {
    KEY_CM: key("COLLATERAL_MANAGER"),
    KEY_LE: key("LENDING_ENGINE"),
    KEY_VAULT_CORE: key("VAULT_CORE"),
    KEY_VAULT_BUSINESS_LOGIC: key("VAULT_BUSINESS_LOGIC"),
    KEY_ACCESS_CONTROL: key("ACCESS_CONTROL_MANAGER"),
  };

  console.log("Registry:", registryAddr);
  for (const [n, k] of Object.entries(keys)) {
    const addr = await registry.getModule(k);
    console.log(n, addr);
  }

  try {
    const reg = await pv.getRegistry();
    console.log("PositionView.registry:", reg);
  } catch (e) {
    console.log("PositionView.getRegistry revert:", e);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});





