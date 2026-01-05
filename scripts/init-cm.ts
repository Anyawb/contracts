import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../frontend-config/contracts-localhost";

async function main() {
  const [deployer] = await ethers.getSigners();
  const cm = (await ethers.getContractAt("CollateralManager", CONTRACT_ADDRESSES.CollateralManager)) as any;
  console.log("init registry", CONTRACT_ADDRESSES.Registry);
  const tx = await cm.connect(deployer).initialize(CONTRACT_ADDRESSES.Registry);
  await tx.wait();
  const slot2 = await ethers.provider.getStorage(CONTRACT_ADDRESSES.CollateralManager, 2n);
  console.log("slot2 after init:", slot2);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
