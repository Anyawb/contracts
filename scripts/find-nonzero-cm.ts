import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../frontend-config/contracts-localhost";

async function main() {
  const cm = CONTRACT_ADDRESSES.CollateralManager;
  for (let i = 0; i < 200; i++) {
    const v = await ethers.provider.getStorage(cm, BigInt(i));
    if (v !== '0x' && BigInt(v) !== 0n) {
      console.log(`slot ${i}:`, v);
    }
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
