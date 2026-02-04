import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";

const BLOCKS_PER_DAY = 7_200n;

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function calcTotalDue(principal: bigint, rateBps: bigint, termBlocks: bigint) {
  // interest = principal * rate / 1e4 * term / 365 days (block-based)
  const denom = 365n * BLOCKS_PER_DAY * 10_000n;
  const interest = (principal * rateBps * termBlocks) / denom;
  return principal + interest;
}

async function main() {
  const [deployer, borrower, lender] = await ethers.getSigners();

  const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
  const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;
  const aw = (await ethers.getContractAt("AssetWhitelist", CONTRACT_ADDRESSES.AssetWhitelist)) as any;
  const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", CONTRACT_ADDRESSES.PriceOracle)) as any;
  const usdc = (await ethers.getContractAt("MockERC20", CONTRACT_ADDRESSES.MockUSDC)) as any;
  const vaultCore = (await ethers.getContractAt("VaultCore", CONTRACT_ADDRESSES.VaultCore)) as any;

  // Resolve modules from registry to avoid name confusion
  const orderEngineAddr = await registry.getModuleOrRevert(key("ORDER_ENGINE"));
  const loanNftAddr = await registry.getModuleOrRevert(key("LOAN_NFT"));
  const feeRouterAddr = await registry.getModuleOrRevert(key("FEE_ROUTER"));

  const orderEngine = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", orderEngineAddr)) as any;
  const loanNft = (await ethers.getContractAt("LoanNFT", loanNftAddr)) as any;

  console.log("ORDER_ENGINE", orderEngineAddr);
  console.log("LOAN_NFT", loanNftAddr);
  console.log("FEE_ROUTER", feeRouterAddr);

  // Roles
  const ACTION_ADD_WHITELIST = key("ADD_WHITELIST");
  const ACTION_UPDATE_PRICE = key("UPDATE_PRICE");
  const ACTION_ORDER_CREATE = key("ORDER_CREATE");
  const ACTION_REPAY = key("REPAY");
  const ACTION_BORROW = key("BORROW"); // LoanNFT MINTER_ROLE maps to ACTION_BORROW
  const ACTION_DEPOSIT = key("DEPOSIT"); // FeeRouter distributeNormal permission

  const ensureRole = async (role: string, who: string) => {
    if (!(await acm.hasRole(role, who))) {
      await acm.grantRole(role, who);
    }
  };

  // Ensure permissions
  await ensureRole(ACTION_ADD_WHITELIST, deployer.address);
  await ensureRole(ACTION_UPDATE_PRICE, deployer.address);

  // Order engine needs BORROW to mint/update LoanNFT
  await ensureRole(ACTION_BORROW, orderEngineAddr);
  // Optional: allow FeeRouter fee distribution from order engine
  await ensureRole(ACTION_DEPOSIT, orderEngineAddr);

  // Borrower needs create+repay
  await ensureRole(ACTION_ORDER_CREATE, borrower.address);
  await ensureRole(ACTION_REPAY, borrower.address);

  // Whitelist + price
  if (!(await aw.isAssetAllowed(usdc.target))) {
    await aw.connect(deployer).addAllowedAsset(usdc.target);
  }
  {
    const cfg = await po.getAssetConfig(usdc.target);
    if (!cfg.isActive) {
      const usdcDecimals = Number(await usdc.decimals().catch(() => 6));
      await po.connect(deployer).configureAsset(usdc.target, "usd-coin", usdcDecimals, 3600);
    }
  }
  const blockNumber = await ethers.provider.getBlockNumber();
  await po.connect(deployer).updatePrice(usdc.target, ethers.parseUnits("1", 8), blockNumber);

  // Fund users
  await usdc.connect(deployer).transfer(borrower.address, ethers.parseUnits("10000", 6));
  await usdc.connect(deployer).transfer(lender.address, ethers.parseUnits("10000", 6));

  // Simulate lender disbursement to borrower (more realistic than pure order record)
  const principal = ethers.parseUnits("500", 6);
  await usdc.connect(lender).transfer(borrower.address, principal);

  // Create loan order
  const term = 5n * BLOCKS_PER_DAY; // must match DUR_5D (block-based)
  const rateBps = 1000n; // 10%

  const borrowerTokensBefore = await loanNft.getUserTokens(borrower.address);

  const tx = await orderEngine.connect(borrower).createLoanOrder({
    principal,
    rate: rateBps,
    term,
    borrower: borrower.address,
    lender: CONTRACT_ADDRESSES.LenderPoolVault,
    asset: usdc.target,
    startTimestamp: 0,
    maturity: 0,
    repaidAmount: 0,
  });
  const receipt = await tx.wait();

  // Infer orderId from event LoanOrderCreated(orderId,...)
  let orderId: bigint | null = null;
  for (const log of receipt!.logs) {
    try {
      const parsed = orderEngine.interface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "LoanOrderCreated") {
        orderId = parsed.args.orderId as bigint;
        break;
      }
    } catch {
      // ignore
    }
  }
  if (orderId === null) throw new Error("LoanOrderCreated not found; cannot infer orderId");
  console.log("orderId", orderId.toString());

  const borrowerTokensAfter = await loanNft.getUserTokens(borrower.address);
  console.log("borrower LoanNFT tokens before/after", borrowerTokensBefore.length, borrowerTokensAfter.length);
  const newTokenId = borrowerTokensAfter.find((t) => !borrowerTokensBefore.includes(t));
  console.log("minted tokenId", newTokenId?.toString());

  // Ensure debt ledger is populated before repay (VaultCore path).
  const collateralAmt = ethers.parseUnits("1000", 6);
  await usdc.connect(borrower).approve(CONTRACT_ADDRESSES.CollateralManager, collateralAmt);
  await vaultCore.connect(borrower).deposit(usdc.target, collateralAmt);
  await vaultCore.connect(borrower).borrow(usdc.target, principal);

  // Repay full
  const totalDue = calcTotalDue(principal, rateBps, term);
  console.log("totalDue", totalDue.toString());

  await usdc.connect(borrower).approve(orderEngineAddr, totalDue);

  const lenderBalBefore = await usdc.balanceOf(lender.address);
  const repayTx = await orderEngine.connect(borrower).repay(orderId, totalDue);
  await repayTx.wait();
  const lenderBalAfter = await usdc.balanceOf(lender.address);
  console.log("lender balance delta", (lenderBalAfter - lenderBalBefore).toString());

  if (newTokenId !== undefined) {
    const meta = await loanNft.getLoanMetadata(newTokenId);
    console.log("LoanNFT status after repay", meta.status);
  }

  console.log("Order-engine E2E flow completed");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
