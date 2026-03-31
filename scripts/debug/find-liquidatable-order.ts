import { ethers } from "hardhat";

function key(name: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

function envNumber(name: string, fallback: string) {
  const raw = process.env[name]?.trim();
  return Number(raw && raw.length > 0 ? raw : fallback);
}

async function main() {
  const registryAddr = process.env.REGISTRY_ADDRESS?.trim();
  if (!registryAddr) {
    throw new Error("set REGISTRY_ADDRESS");
  }

  const maxOrders = envNumber("LIQUIDATION_SEARCH_MAX_ORDERS", "100");
  const maxMatches = envNumber("FIND_LIQUIDATABLE_MAX_MATCHES", "5");
  const skipRecentOrders = envNumber("FIND_LIQUIDATABLE_SKIP_RECENT", "0");

  const registry = await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    registryAddr,
  );

  const orderEngineAddr = await registry.getModuleOrRevert(key("ORDER_ENGINE"));
  const loanNftAddr = await registry.getModuleOrRevert(key("LOAN_NFT"));
  const lendingEngineAddr = await registry.getModuleOrRevert(key("LENDING_ENGINE"));
  const healthViewAddr = await registry.getModuleOrRevert(key("HEALTH_VIEW"));
  const liquidationRiskViewAddr = await registry.getModuleOrRevert(key("LIQUIDATION_RISK_VIEW"));
  const settlementManagerAddr = await registry.getModuleOrRevert(key("SETTLEMENT_MANAGER"));

  const orderEngine = await ethers.getContractAt(
    [
      "function getLoanOrderForView(uint256 orderId) view returns (tuple(uint256 principal,uint256 rate,uint256 term,address borrower,address lender,address asset,uint256 startBlock,uint256 maturity,uint256 repaidAmount))",
    ],
    orderEngineAddr,
  );
  const loanNft = await ethers.getContractAt(
    [
      "function totalSupply() view returns (uint256)",
      "function tokenByIndex(uint256 index) view returns (uint256)",
      "function getLoanMetadata(uint256 tokenId) view returns (tuple(uint256 principal,uint256 rate,uint256 term,uint256 oraclePrice,uint256 loanId,bytes32 collateralHash,uint8 status))",
    ],
    loanNftAddr,
  );
  const lendingEngine = await ethers.getContractAt(
    [
      "function getDebt(address user,address asset) view returns (uint256)",
      "function getReducibleDebtAmount(address user,address asset) view returns (uint256)",
    ],
    lendingEngineAddr,
  );
  const healthView = await ethers.getContractAt(
    ["function getUserHealthFactorWithMeta(address user) view returns (uint256,bool,uint256)"],
    healthViewAddr,
  );
  const liquidationRiskView = await ethers.getContractAt(
    [
      "function isLiquidatable(address user) view returns (bool,bool,uint256)",
      "function getLiquidationRiskScore(address user) view returns (uint256,bool,uint256)",
    ],
    liquidationRiskViewAddr,
  );
  const settlementManager = await ethers.getContractAt(
    ["function settleOrLiquidate(uint256 orderId)"],
    settlementManagerAddr,
  );

  const currentBlock = BigInt(await ethers.provider.getBlockNumber());
  const totalSupply = Number(await loanNft.totalSupply());
  const candidates: bigint[] = [];
  const seen = new Set<string>();

  for (let index = totalSupply - 1 - skipRecentOrders; index >= 0 && candidates.length < maxOrders; index -= 1) {
    const tokenId = await loanNft.tokenByIndex(index);
    const metadata = await loanNft.getLoanMetadata(tokenId);
    const orderId = BigInt(metadata.loanId);
    const orderIdKey = orderId.toString();
    if (orderId === 0n || seen.has(orderIdKey)) {
      continue;
    }
    seen.add(orderIdKey);
    candidates.push(orderId);
  }

  const matches: Array<Record<string, string | boolean>> = [];
  for (const orderId of candidates) {
    try {
      const order = await orderEngine.getLoanOrderForView(orderId);
      const borrower = String(order.borrower);
      const asset = String(order.asset);
      const maturity = BigInt(order.maturity);
      if (borrower === ethers.ZeroAddress || currentBlock <= maturity) {
        continue;
      }

      const debt = BigInt(await lendingEngine.getDebt(borrower, asset));
      const reducibleDebt = BigInt(await lendingEngine.getReducibleDebtAmount(borrower, asset));
      if (debt === 0n || reducibleDebt === 0n) {
        continue;
      }

      const [healthFactor, healthValid, healthBlock] = await healthView.getUserHealthFactorWithMeta(borrower);
      const [liquidatable, liqValid, liqBlock] = await liquidationRiskView.isLiquidatable(borrower);
      const [riskScore, riskValid, riskBlock] = await liquidationRiskView.getLiquidationRiskScore(borrower);

      if (!healthValid || BigInt(healthFactor) >= 10500n || !liquidatable || !liqValid) {
        continue;
      }

      let staticCallOk = true;
      let staticCallError = "";
      try {
        await settlementManager.settleOrLiquidate.staticCall(orderId);
      } catch (error) {
        staticCallOk = false;
        staticCallError = error instanceof Error ? error.message : String(error);
      }

      matches.push({
        orderId: orderId.toString(),
        borrower,
        asset,
        maturity: maturity.toString(),
        currentBlock: currentBlock.toString(),
        debt: debt.toString(),
        reducibleDebt: reducibleDebt.toString(),
        healthFactor: BigInt(healthFactor).toString(),
        healthValid,
        healthBlock: BigInt(healthBlock).toString(),
        liquidatable,
        liqValid,
        liqBlock: BigInt(liqBlock).toString(),
        riskScore: BigInt(riskScore).toString(),
        riskValid,
        riskBlock: BigInt(riskBlock).toString(),
        settleOrLiquidateStaticCallOk: staticCallOk,
        settleOrLiquidateStaticCallError: staticCallError,
      });

      if (matches.length >= maxMatches) {
        break;
      }
    } catch {
      continue;
    }
  }

  console.log(JSON.stringify({
    registryAddr,
    totalSupply,
    skipRecentOrders,
    scannedCandidateCount: candidates.length,
    currentBlock: currentBlock.toString(),
    matches,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});