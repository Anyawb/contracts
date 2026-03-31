import { ethers } from "hardhat";

function key(name: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

async function main() {
  const orderIdRaw = process.env.CHECK_ORDER_ID?.trim();
  if (!orderIdRaw) {
    throw new Error("set CHECK_ORDER_ID");
  }

  const orderId = BigInt(orderIdRaw);
  const registryAddr = process.env.REGISTRY_ADDRESS?.trim();
  if (!registryAddr) {
    throw new Error("set REGISTRY_ADDRESS");
  }

  const registry = await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    registryAddr,
  );

  const orderEngineAddr = await registry.getModuleOrRevert(key("ORDER_ENGINE"));
  const lendingEngineAddr = await registry.getModuleOrRevert(key("LENDING_ENGINE"));
  const liquidationRiskViewAddr = await registry.getModuleOrRevert(key("LIQUIDATION_RISK_VIEW"));
  const liquidationViewAddr = await registry.getModuleOrRevert(key("LIQUIDATION_VIEW"));
  const settlementManagerAddr = await registry.getModuleOrRevert(key("SETTLEMENT_MANAGER"));

  const orderEngine = await ethers.getContractAt(
    [
      "function getLoanOrderForView(uint256 orderId) view returns (tuple(uint256 principal,uint256 rate,uint256 term,address borrower,address lender,address asset,uint256 startBlock,uint256 maturity,uint256 repaidAmount))",
    ],
    orderEngineAddr,
  );
  const lendingEngine = await ethers.getContractAt(
    [
      "function getDebt(address user,address asset) view returns (uint256)",
      "function getReducibleDebtAmount(address user,address asset) view returns (uint256)",
    ],
    lendingEngineAddr,
  );
  const liquidationRiskView = await ethers.getContractAt(
    [
      "function isLiquidatable(address user) view returns (bool,bool,uint256)",
      "function getLiquidationRiskScore(address user) view returns (uint256,bool,uint256)",
    ],
    liquidationRiskViewAddr,
  );
  const liquidationView = await ethers.getContractAt(
    [
      "function getSeizableCollaterals(address user) view returns (address[] memory,uint256[] memory,uint256,bool)",
    ],
    liquidationViewAddr,
  );
  const settlementManager = await ethers.getContractAt(
    ["function settleOrLiquidate(uint256 orderId)"],
    settlementManagerAddr,
  );

  const order = await orderEngine.getLoanOrderForView(orderId);
  const borrower = String(order.borrower);
  const asset = String(order.asset);
  const debt = await lendingEngine.getDebt(borrower, asset);
  const reducible = await lendingEngine.getReducibleDebtAmount(borrower, asset);
  const currentBlock = BigInt(await ethers.provider.getBlockNumber());
  const [liquidatable, metadataValid, liqBlock] = await liquidationRiskView.isLiquidatable(borrower);
  const [riskScore, riskValid, riskMetaBlock] = await liquidationRiskView.getLiquidationRiskScore(borrower);
  const [seizableAssets, seizableAmounts] = await liquidationView.getSeizableCollaterals(borrower);

  let staticCallOk = true;
  let staticCallError = "";
  try {
    await settlementManager.settleOrLiquidate.staticCall(orderId);
  } catch (error) {
    staticCallOk = false;
    staticCallError = error instanceof Error ? error.message : String(error);
  }

  const result = {
    orderId: orderId.toString(),
    borrower,
    lender: String(order.lender),
    asset,
    principal: BigInt(order.principal).toString(),
    repaidAmount: BigInt(order.repaidAmount).toString(),
    startBlock: BigInt(order.startBlock).toString(),
    maturity: BigInt(order.maturity).toString(),
    currentBlock: currentBlock.toString(),
    overdue: currentBlock > BigInt(order.maturity),
    debt: BigInt(debt).toString(),
    reducibleDebt: BigInt(reducible).toString(),
    liquidatable,
    metadataValid,
    liquidationMetaBlock: BigInt(liqBlock).toString(),
    riskScore: BigInt(riskScore).toString(),
    riskValid,
    riskScoreMetaBlock: BigInt(riskMetaBlock).toString(),
    seizableAssets: seizableAssets.map((value: string) => String(value)),
    seizableAmounts: seizableAmounts.map((value: bigint) => BigInt(value).toString()),
    seizableTotal: seizableAmounts.reduce((sum: bigint, value: bigint) => sum + BigInt(value), 0n).toString(),
    settleOrLiquidateStaticCallOk: staticCallOk,
    settleOrLiquidateStaticCallError: staticCallError,
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});