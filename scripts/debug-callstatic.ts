import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../frontend-config/contracts-localhost";

async function main() {
  const [, borrower] = await ethers.getSigners();
  const addr = CONTRACT_ADDRESSES.VaultCore;
  const code = await ethers.provider.getCode(addr);
  console.log("VaultCore addr", addr, "code length", code.length);
  const vaultCore = (await ethers.getContractAt("VaultCore", addr)) as any;
  const registryAddr = await vaultCore.registryAddrVar();
  const viewAddr = await vaultCore.viewContractAddrVar();
  console.log("vaultCore registry", registryAddr, "view", viewAddr);
  const registry = (await ethers.getContractAt("Registry", registryAddr)) as any;
  const key = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
  const cm = await registry.getModuleOrRevert(key("COLLATERAL_MANAGER"));
  const le = await registry.getModuleOrRevert(key("LENDING_ENGINE"));
  const pv = await registry.getModuleOrRevert(key("POSITION_VIEW"));
  const vbl = await registry.getModuleOrRevert(key("VAULT_BUSINESS_LOGIC"));
  console.log("registry modules cm/le/pv/vbl", cm, le, pv, vbl);
  try {
    await vaultCore.connect(borrower).deposit.staticCall(CONTRACT_ADDRESSES.MockUSDC, ethers.parseUnits("1000", 6));
    console.log("staticCall deposit would succeed");
  } catch (e: any) {
    console.error("staticCall error data:", e.data ?? e.error?.data);
    console.error("staticCall message:", e.shortMessage ?? e.message);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
