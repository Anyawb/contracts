import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../frontend-config/contracts-localhost";

async function main() {
  const slot0 = await ethers.provider.getStorage(CONTRACT_ADDRESSES.CollateralManager, 0n);
  const slot1 = await ethers.provider.getStorage(CONTRACT_ADDRESSES.CollateralManager, 1n);
  console.log("slot0", slot0);
  console.log("slot1", slot1);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
