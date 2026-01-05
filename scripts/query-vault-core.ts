import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../frontend-config/contracts-localhost";

async function main() {
  const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
  const key = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
  const vaultCoreAddr = await registry.getModuleOrRevert(key("VAULT_CORE"));
  console.log(vaultCoreAddr);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
