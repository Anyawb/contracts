import { ethers, network } from "hardhat";

import { envBool } from "../tests/_addressResolver";
import { createFundsFlowLiveContext, getGuaranteeState } from "../tests/live-test/networks/arbitrum-sepolia/core/_fundsFlowLive";

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

type GrantSpec = {
  roleName: string;
  account: string;
  label: string;
};

function roleKey(roleName: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(roleName));
}

async function readImplementation(proxy: string) {
  const raw = await ethers.provider.getStorage(proxy, EIP1967_IMPLEMENTATION_SLOT);
  return ethers.getAddress(`0x${raw.slice(-40)}`);
}

function short(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

async function printRoleMatrix(acm: any, grants: GrantSpec[]) {
  console.log("\n[Role Matrix]");
  for (const grant of grants) {
    const hasRole = (await acm.hasRole(roleKey(grant.roleName), grant.account)) as boolean;
    console.log(`- ${grant.roleName.padEnd(16)} ${grant.label.padEnd(28)} ${short(grant.account)} => ${hasRole}`);
  }
}

async function applyMissingRoles(acm: any, grants: GrantSpec[]) {
  console.log("\n[Apply Missing Roles]");
  for (const grant of grants) {
    const role = roleKey(grant.roleName);
    const hasRole = (await acm.hasRole(role, grant.account)) as boolean;
    if (hasRole) {
      continue;
    }
    await (await acm.grantRole(role, grant.account)).wait();
    console.log(`granted ${grant.roleName} -> ${grant.label} (${grant.account})`);
  }
}

async function main() {
  if (network.name !== "arbitrumSepolia") {
    throw new Error(`expected --network arbitrumSepolia, got ${network.name}`);
  }

  const ctx = await createFundsFlowLiveContext({
    label: "Live Runtime Audit",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "500",
  });

  const acmOwner = (await ctx.acm.owner()) as string;
  const apply = envBool("APPLY", false);
  const registry = (await ethers.getContractAt(
    [
      "function getModule(bytes32) view returns (address)",
      "function getModuleOrRevert(bytes32) view returns (address)",
    ],
    ctx.registryAddr,
  )) as any;

  const settlementManagerAddr = (await registry.getModuleOrRevert(roleKey("SETTLEMENT_MANAGER"))) as string;
  const blocksOnlyCoordinatorAddr = (await registry.getModule(roleKey("BLOCKS_ONLY_COORDINATOR"))) as string;
  const liquidationManagerAddr = (await registry.getModule(roleKey("LIQUIDATION_MANAGER"))) as string;
  const guaranteeFundManagerAddr = (await registry.getModule(roleKey("GUARANTEE_FUND_MANAGER"))) as string;
  const orderEngineAddr = (await registry.getModuleOrRevert(roleKey("ORDER_ENGINE"))) as string;

  const implementation = await readImplementation(ctx.vblAddr);
  const codeHash = ethers.keccak256(await ethers.provider.getCode(implementation));

  console.log(`Network=${network.name}`);
  console.log(`Registry=${ctx.registryAddr}`);
  console.log(`ACM=${await ctx.acm.getAddress()}`);
  console.log(`ACM Owner=${acmOwner}`);
  console.log(`Relayer=${ctx.relayer.address}`);
  console.log(`Borrower=${ctx.borrower.address}`);
  console.log(`Lender=${ctx.lender.address}`);
  console.log(`BorrowAsset=${ctx.borrowAssetAddr}`);
  console.log(`VaultBusinessLogic=${ctx.vblAddr}`);
  console.log(`VBL Implementation=${implementation}`);
  console.log(`VBL Impl CodeHash=${codeHash}`);
  console.log(`Selector GuaranteeAlreadyProcessed()=${ethers.keccak256(ethers.toUtf8Bytes("GuaranteeAlreadyProcessed()")).slice(0, 10)}`);
  console.log(`Selector MissingRole()=${ethers.keccak256(ethers.toUtf8Bytes("MissingRole()")).slice(0, 10)}`);

  const grants: GrantSpec[] = [
    { roleName: "LIQUIDATE", account: ctx.relayer.address, label: "relayer" },
    { roleName: "DEPOSIT", account: ctx.relayer.address, label: "relayer" },
    { roleName: "LIQUIDATE", account: settlementManagerAddr, label: "SettlementManager" },
    { roleName: "VIEW_RISK_DATA", account: settlementManagerAddr, label: "SettlementManager" },
    { roleName: "REPAY", account: settlementManagerAddr, label: "SettlementManager" },
    { roleName: "LIQUIDATE", account: blocksOnlyCoordinatorAddr, label: "BlocksOnlyCoordinator" },
    { roleName: "VIEW_RISK_DATA", account: blocksOnlyCoordinatorAddr, label: "BlocksOnlyCoordinator" },
    { roleName: "LIQUIDATE", account: liquidationManagerAddr, label: "LiquidationManager" },
    { roleName: "DEPOSIT", account: liquidationManagerAddr, label: "LiquidationManager" },
    { roleName: "DEPOSIT", account: guaranteeFundManagerAddr, label: "GuaranteeFundManager" },
    { roleName: "ORDER_CREATE", account: ctx.vblAddr, label: "VaultBusinessLogic" },
    { roleName: "DEPOSIT", account: ctx.vblAddr, label: "VaultBusinessLogic" },
    { roleName: "BORROW", account: orderEngineAddr, label: "LendingEngine" },
  ].filter((grant) => grant.account && grant.account !== ethers.ZeroAddress);

  await printRoleMatrix(ctx.acm, grants);

  const guaranteeState = await getGuaranteeState(ctx);
  console.log("\n[Guarantee State]");
  console.log(`- enabled=${guaranteeState.enabled}`);
  console.log(`- active=${guaranteeState.active}`);
  console.log(`- locked=${guaranteeState.locked}`);
  console.log(`- guaranteeId=${guaranteeState.guaranteeId}`);
  if (guaranteeState.record) {
    console.log(`- record.lender=${guaranteeState.record.lender}`);
    console.log(`- record.asset=${guaranteeState.record.asset}`);
    console.log(`- record.principal=${guaranteeState.record.principal}`);
    console.log(`- record.promisedInterest=${guaranteeState.record.promisedInterest}`);
    console.log(`- record.isActive=${guaranteeState.record.isActive}`);
  }

  if (!apply) {
    console.log("\nAPPLY=0, audit only.");
    return;
  }
  if (acmOwner.toLowerCase() !== ctx.relayer.address.toLowerCase()) {
    throw new Error(`relayer is not ACM owner; cannot apply grants. owner=${acmOwner} relayer=${ctx.relayer.address}`);
  }

  await applyMissingRoles(ctx.acm.connect(ctx.relayer), grants);
  await printRoleMatrix(ctx.acm, grants);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});