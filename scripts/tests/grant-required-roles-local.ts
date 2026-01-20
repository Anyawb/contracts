import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";

function key(name: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

async function main() {
  const [deployer, keeper] = await ethers.getSigners();

  const acmAddr = (CONTRACT_ADDRESSES as any)?.AccessControlManager as string | undefined;
  const settlementManagerAddr = (CONTRACT_ADDRESSES as any)?.SettlementManager as string | undefined;
  const vaultBusinessLogicAddr = (CONTRACT_ADDRESSES as any)?.VaultBusinessLogic as string | undefined;
  if (!acmAddr) throw new Error("[Config] Missing CONTRACT_ADDRESSES.AccessControlManager (run deploy:localhost first).");
  if (!settlementManagerAddr) {
    throw new Error("[Config] Missing CONTRACT_ADDRESSES.SettlementManager (run deploy:localhost first).");
  }
  if (!vaultBusinessLogicAddr) {
    throw new Error("[Config] Missing CONTRACT_ADDRESSES.VaultBusinessLogic (run deploy:localhost first).");
  }

  // Resolve ORDER_ENGINE dynamically via Registry (SSOT).
  const registryAddr = (CONTRACT_ADDRESSES as any)?.Registry as string | undefined;
  if (!registryAddr) throw new Error("[Config] Missing CONTRACT_ADDRESSES.Registry (run deploy:localhost first).");
  const registry = await ethers.getContractAt(["function getModuleOrRevert(bytes32) view returns (address)"], registryAddr);
  const orderEngineAddr: string = await registry.getModuleOrRevert(key("ORDER_ENGINE"));

  const acm: any = await ethers.getContractAt("AccessControlManager", acmAddr);
  const owner: string = await acm.owner();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`[AccessControl] This script requires ACM owner signer. owner=${owner} deployer=${deployer.address}`);
  }

  const ACTION_LIQUIDATE = key("LIQUIDATE");
  const ACTION_REPAY = key("REPAY");
  const ACTION_VIEW_SYSTEM_DATA = key("VIEW_SYSTEM_DATA");
  const ACTION_ORDER_CREATE = key("ORDER_CREATE");
  const ACTION_DEPOSIT = key("DEPOSIT");
  const ACTION_BORROW = key("BORROW");

  // Deployer roles used by smoke create-order script setup steps (AssetWhitelist/PriceOracle/FeeRouter).
  const ACTION_ADD_WHITELIST = key("ADD_WHITELIST");
  const ACTION_UPDATE_PRICE = key("UPDATE_PRICE");
  const ACTION_SET_PARAMETER = key("SET_PARAMETER");

  const grants: Array<{ role: string; who: string; label: string }> = [
    { role: ACTION_ADD_WHITELIST, who: deployer.address, label: "deployer ACTION_ADD_WHITELIST" },
    { role: ACTION_UPDATE_PRICE, who: deployer.address, label: "deployer ACTION_UPDATE_PRICE" },
    { role: ACTION_SET_PARAMETER, who: deployer.address, label: "deployer ACTION_SET_PARAMETER" },
    { role: ACTION_ORDER_CREATE, who: vaultBusinessLogicAddr, label: "VaultBusinessLogic ACTION_ORDER_CREATE" },
    { role: ACTION_DEPOSIT, who: vaultBusinessLogicAddr, label: "VaultBusinessLogic ACTION_DEPOSIT" },
    { role: ACTION_BORROW, who: orderEngineAddr, label: "OrderEngine ACTION_BORROW (LoanNFT minter)" },
    { role: ACTION_LIQUIDATE, who: keeper.address, label: "keeper ACTION_LIQUIDATE" },
    { role: ACTION_REPAY, who: settlementManagerAddr, label: "settlementManager ACTION_REPAY" },
    { role: ACTION_VIEW_SYSTEM_DATA, who: settlementManagerAddr, label: "settlementManager ACTION_VIEW_SYSTEM_DATA" },
  ];

  console.log("=== Grant required roles (localhost) ===\n");
  console.log("  ACM:", acmAddr);
  console.log("  ACM owner:", owner);
  console.log("  deployer:", deployer.address);
  console.log("  keeper:", keeper.address);
  console.log("  settlementManager:", settlementManagerAddr);
  console.log("  vaultBusinessLogic:", vaultBusinessLogicAddr);
  console.log("  orderEngine:", orderEngineAddr);
  console.log("");

  for (const g of grants) {
    const has = await acm.hasRole(g.role, g.who);
    console.log(`  ${g.label}: hasRole=${has}`);
    if (has) continue;
    const tx = await acm.grantRole(g.role, g.who);
    console.log(`    grantRole tx: ${tx.hash}`);
    await tx.wait();
    const ok = await acm.hasRole(g.role, g.who);
    console.log(`    granted: ${ok}`);
    if (!ok) throw new Error(`[AccessControl] failed to grant ${g.label}`);
  }

  console.log("\n✅ Done.\n");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

