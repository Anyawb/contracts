import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost.ts";

function key(name: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

async function main() {
  const [deployer, keeper] = await ethers.getSigners();

  const acmAddr = (CONTRACT_ADDRESSES as any)?.AccessControlManager as string | undefined;
  const settlementManagerAddr = (CONTRACT_ADDRESSES as any)?.SettlementManager as string | undefined;
  const vaultBusinessLogicAddr = (CONTRACT_ADDRESSES as any)?.VaultBusinessLogic as string | undefined;
  const liquidationManagerAddr = (CONTRACT_ADDRESSES as any)?.LiquidationManager as string | undefined;
  const guaranteeFundManagerAddr = (CONTRACT_ADDRESSES as any)?.GuaranteeFundManager as string | undefined;
  const vaultLendingEngineAddr = (CONTRACT_ADDRESSES as any)?.VaultLendingEngine as string | undefined;
  const registryAddr = (CONTRACT_ADDRESSES as any)?.Registry as string | undefined;

  if (!acmAddr) throw new Error("[Config] Missing CONTRACT_ADDRESSES.AccessControlManager (run deploy:localhost first).");
  if (!settlementManagerAddr) throw new Error("[Config] Missing CONTRACT_ADDRESSES.SettlementManager (run deploy:localhost first).");
  if (!vaultBusinessLogicAddr) throw new Error("[Config] Missing CONTRACT_ADDRESSES.VaultBusinessLogic (run deploy:localhost first).");
  if (!liquidationManagerAddr) throw new Error("[Config] Missing CONTRACT_ADDRESSES.LiquidationManager (run deploy:localhost first).");
  if (!guaranteeFundManagerAddr) throw new Error("[Config] Missing CONTRACT_ADDRESSES.GuaranteeFundManager (run deploy:localhost first).");
  if (!vaultLendingEngineAddr) throw new Error("[Config] Missing CONTRACT_ADDRESSES.VaultLendingEngine (run deploy:localhost first).");
  if (!registryAddr) throw new Error("[Config] Missing CONTRACT_ADDRESSES.Registry (run deploy:localhost first).");

  const registry = await ethers.getContractAt(["function getModuleOrRevert(bytes32) view returns (address)"], registryAddr);
  const orderEngineAddr: string = await registry.getModuleOrRevert(key("ORDER_ENGINE"));

  const acm: any = await ethers.getContractAt("AccessControlManager", acmAddr);
  const owner: string = await acm.owner();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`[AccessControl] This script requires ACM owner signer. owner=${owner} deployer=${deployer.address}`);
  }

  const roles = {
    // Create-order smoke prereqs
    ACTION_ADD_WHITELIST: key("ADD_WHITELIST"),
    ACTION_UPDATE_PRICE: key("UPDATE_PRICE"),
    ACTION_SET_PARAMETER: key("SET_PARAMETER"),
    ACTION_ORDER_CREATE: key("ORDER_CREATE"),
    ACTION_DEPOSIT: key("DEPOSIT"),
    ACTION_BORROW: key("BORROW"),
    // Keeper-path smoke prereqs
    ACTION_LIQUIDATE: key("LIQUIDATE"),
    ACTION_REPAY: key("REPAY"),
    ACTION_VIEW_SYSTEM_DATA: key("VIEW_SYSTEM_DATA"),
    ACTION_VIEW_RISK_DATA: key("VIEW_RISK_DATA"),
    ACTION_VIEW_PUSH: key("ACTION_VIEW_PUSH"),
  };

  // By default, revoke only a small subset to demonstrate fail-fast behavior.
  // You can override with FULL=1 to revoke everything in this list.
  const full = String(process.env.FULL ?? "") === "1";
  const targets: Array<{ role: string; who: string; label: string }> = full
    ? [
        { role: roles.ACTION_ADD_WHITELIST, who: deployer.address, label: "deployer ACTION_ADD_WHITELIST" },
        { role: roles.ACTION_UPDATE_PRICE, who: deployer.address, label: "deployer ACTION_UPDATE_PRICE" },
        { role: roles.ACTION_SET_PARAMETER, who: deployer.address, label: "deployer ACTION_SET_PARAMETER" },
        { role: roles.ACTION_ORDER_CREATE, who: vaultBusinessLogicAddr, label: "VaultBusinessLogic ACTION_ORDER_CREATE" },
        { role: roles.ACTION_DEPOSIT, who: vaultBusinessLogicAddr, label: "VaultBusinessLogic ACTION_DEPOSIT" },
        { role: roles.ACTION_BORROW, who: orderEngineAddr, label: "OrderEngine ACTION_BORROW (LoanNFT minter)" },
        { role: roles.ACTION_LIQUIDATE, who: keeper.address, label: "keeper ACTION_LIQUIDATE" },
        { role: roles.ACTION_DEPOSIT, who: liquidationManagerAddr, label: "LiquidationManager ACTION_DEPOSIT" },
        { role: roles.ACTION_DEPOSIT, who: guaranteeFundManagerAddr, label: "GuaranteeFundManager ACTION_DEPOSIT" },
        { role: roles.ACTION_REPAY, who: settlementManagerAddr, label: "settlementManager ACTION_REPAY" },
        { role: roles.ACTION_VIEW_SYSTEM_DATA, who: settlementManagerAddr, label: "settlementManager ACTION_VIEW_SYSTEM_DATA" },
        { role: roles.ACTION_VIEW_PUSH, who: vaultLendingEngineAddr, label: "VaultLendingEngine ACTION_VIEW_PUSH" },
        { role: roles.ACTION_VIEW_RISK_DATA, who: vaultLendingEngineAddr, label: "VaultLendingEngine ACTION_VIEW_RISK_DATA" },
      ]
    : [
        // Minimal demo: revoke one critical role used by create-order
        { role: roles.ACTION_ORDER_CREATE, who: vaultBusinessLogicAddr, label: "VaultBusinessLogic ACTION_ORDER_CREATE" },
      ];

  console.log("=== Revoke required roles (localhost) ===\n");
  console.log("  ACM:", acmAddr);
  console.log("  ACM owner:", owner);
  console.log("  deployer:", deployer.address);
  console.log("  keeper:", keeper.address);
  console.log("  settlementManager:", settlementManagerAddr);
  console.log("  vaultBusinessLogic:", vaultBusinessLogicAddr);
  console.log("  liquidationManager:", liquidationManagerAddr);
  console.log("  guaranteeFundManager:", guaranteeFundManagerAddr);
  console.log("  vaultLendingEngine:", vaultLendingEngineAddr);
  console.log("  orderEngine:", orderEngineAddr);
  console.log("  mode:", full ? "FULL=1" : "minimal");
  console.log("");

  for (const t of targets) {
    const has = await acm.hasRole(t.role, t.who);
    console.log(`  ${t.label}: hasRole=${has}`);
    if (!has) continue;
    const tx = await acm.revokeRole(t.role, t.who);
    console.log(`    revokeRole tx: ${tx.hash}`);
    await tx.wait();
    const ok = await acm.hasRole(t.role, t.who);
    console.log(`    revoked: ${!ok}`);
    if (ok) throw new Error(`[AccessControl] failed to revoke ${t.label}`);
  }

  console.log("\n✅ Done.\n");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

