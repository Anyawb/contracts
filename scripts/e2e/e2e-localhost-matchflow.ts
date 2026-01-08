import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";

const ONE_DAY = 24n * 60n * 60n;

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function calcTotalDue(principal: bigint, rateBps: bigint, termSec: bigint) {
  const denom = 365n * ONE_DAY * 10_000n;
  const interest = (principal * rateBps * termSec) / denom;
  return principal + interest;
}

function buildLendIntentHash(li: any) {
  const typeHash = ethers.keccak256(
    ethers.toUtf8Bytes(
      "LendIntent(address lenderSigner,address asset,uint256 amount,uint16 minTermDays,uint16 maxTermDays,uint256 minRateBps,uint256 expireAt,bytes32 salt)"
    )
  );
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(
    coder.encode(
      ["bytes32", "address", "address", "uint256", "uint16", "uint16", "uint256", "uint256", "bytes32"],
      [
        typeHash,
        li.lenderSigner,
        li.asset,
        li.amount,
        li.minTermDays,
        li.maxTermDays,
        li.minRateBps,
        li.expireAt,
        li.salt,
      ]
    )
  );
}

async function main() {
  const [deployer, borrower, lender] = await ethers.getSigners();

  const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
  const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;
  const aw = (await ethers.getContractAt("AssetWhitelist", CONTRACT_ADDRESSES.AssetWhitelist)) as any;
  const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", CONTRACT_ADDRESSES.PriceOracle)) as any;
  const feeRouter = (await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", CONTRACT_ADDRESSES.FeeRouter)) as any;
  const usdc = (await ethers.getContractAt("MockERC20", CONTRACT_ADDRESSES.MockUSDC)) as any;
  const vaultCore = (await ethers.getContractAt("VaultCore", CONTRACT_ADDRESSES.VaultCore)) as any;
  const vbl = (await ethers.getContractAt("VaultBusinessLogic", CONTRACT_ADDRESSES.VaultBusinessLogic)) as any;

  const orderEngineAddr = await registry.getModuleOrRevert(key("ORDER_ENGINE"));
  const orderEngine = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", orderEngineAddr)) as any;
  const loanNftAddr = await registry.getModuleOrRevert(key("LOAN_NFT"));
  const loanNft = await ethers.getContractAt("LoanNFT", loanNftAddr);

  console.log("VaultBusinessLogic", await vbl.getAddress());
  console.log("ORDER_ENGINE", orderEngineAddr);
  console.log("LOAN_NFT", loanNftAddr);

  const ACTION_ADD_WHITELIST = key("ADD_WHITELIST");
  const ACTION_UPDATE_PRICE = key("UPDATE_PRICE");
  const ACTION_SET_PARAMETER = key("SET_PARAMETER");
  const ACTION_DEPOSIT = key("DEPOSIT");
  const ACTION_ORDER_CREATE = key("ORDER_CREATE");
  const ACTION_BORROW = key("BORROW");
  const ACTION_REPAY = key("REPAY");

  const ensureRole = async (role: string, who: string) => {
    if (!(await acm.hasRole(role, who))) await acm.grantRole(role, who);
  };

  // permissions for config
  await ensureRole(ACTION_ADD_WHITELIST, deployer.address);
  await ensureRole(ACTION_UPDATE_PRICE, deployer.address);
  await ensureRole(ACTION_SET_PARAMETER, deployer.address);

  // permissions for match/orchestration contract
  await ensureRole(ACTION_ORDER_CREATE, CONTRACT_ADDRESSES.VaultBusinessLogic);
  await ensureRole(ACTION_DEPOSIT, CONTRACT_ADDRESSES.VaultBusinessLogic);

  // Order engine needs BORROW to mint/update LoanNFT
  await ensureRole(ACTION_BORROW, orderEngineAddr);

  // borrower needs repay on order engine
  await ensureRole(ACTION_REPAY, borrower.address);

  // whitelist + price
  if (!(await aw.isAssetAllowed(usdc.target))) {
    await aw.connect(deployer).addAllowedAsset(usdc.target);
  }
  {
    const cfg = await po.getAssetConfig(usdc.target);
    if (!cfg.isActive) {
      await po.connect(deployer).configureAsset(usdc.target, "usd-coin", 8, 3600);
    }
  }
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  await po.connect(deployer).updatePrice(usdc.target, ethers.parseUnits("1", 6), now);

  // FeeRouter needs supported token
  if (!(await feeRouter.isTokenSupported(usdc.target))) {
    await feeRouter.connect(deployer).addSupportedToken(usdc.target);
  }

  // fund users
  await usdc.connect(deployer).transfer(borrower.address, ethers.parseUnits("20000", 6));
  await usdc.connect(deployer).transfer(lender.address, ethers.parseUnits("20000", 6));

  // borrower deposits collateral first (realistic path)
  const collateralAmt = ethers.parseUnits("1000", 6);
  await usdc.connect(borrower).approve(CONTRACT_ADDRESSES.VaultCore, collateralAmt);
  await vaultCore.connect(borrower).deposit(usdc.target, collateralAmt);

  // prepare intents
  const borrowAmt = ethers.parseUnits("500", 6);
  const termDays = 5;
  const rateBps = 1000n;
  const expireAt = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);

  const borrowIntent = {
    borrower: borrower.address,
    collateralAsset: usdc.target,
    collateralAmount: collateralAmt,
    borrowAsset: usdc.target,
    amount: borrowAmt,
    termDays,
    rateBps,
    expireAt,
    salt: ethers.keccak256(ethers.toUtf8Bytes("borrow-salt-1")),
  };

  const lendIntent = {
    lenderSigner: lender.address,
    asset: usdc.target,
    amount: borrowAmt,
    minTermDays: 1,
    maxTermDays: 30,
    minRateBps: 0n,
    expireAt,
    salt: ethers.keccak256(ethers.toUtf8Bytes("lend-salt-1")),
  };

  // lender reserves funds into VBL
  await usdc.connect(lender).approve(CONTRACT_ADDRESSES.VaultBusinessLogic, borrowAmt);
  const lendHash = buildLendIntentHash(lendIntent);
  await vbl.connect(lender).reserveForLending(lender.address, usdc.target, borrowAmt, lendHash);

  // Sign EIP-712 intents
  const domain = {
    name: "RwaLending",
    version: "1",
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    verifyingContract: CONTRACT_ADDRESSES.VaultBusinessLogic,
  } as const;

  const typesBorrow = {
    BorrowIntent: [
      { name: "borrower", type: "address" },
      { name: "collateralAsset", type: "address" },
      { name: "collateralAmount", type: "uint256" },
      { name: "borrowAsset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "termDays", type: "uint16" },
      { name: "rateBps", type: "uint256" },
      { name: "expireAt", type: "uint256" },
      { name: "salt", type: "bytes32" },
    ],
  };

  const typesLend = {
    LendIntent: [
      { name: "lenderSigner", type: "address" },
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "minTermDays", type: "uint16" },
      { name: "maxTermDays", type: "uint16" },
      { name: "minRateBps", type: "uint256" },
      { name: "expireAt", type: "uint256" },
      { name: "salt", type: "bytes32" },
    ],
  };

  const sigBorrower = await borrower.signTypedData(domain, typesBorrow as any, borrowIntent as any);
  const sigLender = await lender.signTypedData(domain, typesLend as any, lendIntent as any);

  const borrowerTokensBefore = await loanNft.getUserTokens(borrower.address);

  // finalize match
  const tx = await vbl.connect(deployer).finalizeMatch(
    borrowIntent,
    [lendIntent],
    sigBorrower,
    [sigLender]
  );
  const receipt = await tx.wait();

  // infer orderId from order engine event
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
  console.log("orderId", orderId?.toString());

  const borrowerTokensAfter = await loanNft.getUserTokens(borrower.address);
  const newTokenId = borrowerTokensAfter.find((t) => !borrowerTokensBefore.includes(t));
  console.log("LoanNFT tokenId", newTokenId?.toString());

  // repay on order engine
  if (orderId === null) throw new Error("LoanOrderCreated not found");
  const termSec = BigInt(termDays) * ONE_DAY;
  const totalDue = calcTotalDue(borrowAmt, rateBps, termSec);
  // 统一入口：走 VaultCore.repay → SettlementManager（覆盖 SSOT 资金链）
  await usdc.connect(borrower).approve(CONTRACT_ADDRESSES.VaultCore, totalDue);
  await vaultCore.connect(borrower).repay(orderId, usdc.target, totalDue);

  if (newTokenId !== undefined) {
    const meta = await loanNft.getLoanMetadata(newTokenId);
    console.log("LoanNFT status after repay", meta.status);
  }

  console.log("Matchflow E2E completed");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
