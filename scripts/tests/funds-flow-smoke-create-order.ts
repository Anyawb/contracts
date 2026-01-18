import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";

const ONE_DAY = 24n * 60n * 60n;

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
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
  const [deployer, keeper, borrower, lender] = await ethers.getSigners();
  if (keeper.address.toLowerCase() === borrower.address.toLowerCase()) {
    throw new Error("[Config] keeper must differ from borrower for liquidation tests.");
  }

  const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
  const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;
  const aw = (await ethers.getContractAt("AssetWhitelist", CONTRACT_ADDRESSES.AssetWhitelist)) as any;
  const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", CONTRACT_ADDRESSES.PriceOracle)) as any;
  const feeRouter = (await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", CONTRACT_ADDRESSES.FeeRouter)) as any;
  const usdc = (await ethers.getContractAt("MockERC20", CONTRACT_ADDRESSES.MockUSDC)) as any;
  const vaultCore = (await ethers.getContractAt("VaultCore", CONTRACT_ADDRESSES.VaultCore)) as any;
  const vbl = (await ethers.getContractAt("VaultBusinessLogic", CONTRACT_ADDRESSES.VaultBusinessLogic)) as any;

  const orderEngineAddr = await registry.getModuleOrRevert(key("ORDER_ENGINE"));
  const collateralManagerAddr = await registry.getModuleOrRevert(key("COLLATERAL_MANAGER"));
  const orderEngine = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", orderEngineAddr)) as any;
  const loanNftAddr = await registry.getModuleOrRevert(key("LOAN_NFT"));
  const loanNft = await ethers.getContractAt("LoanNFT", loanNftAddr);

  console.log("VaultBusinessLogic", await vbl.getAddress());
  console.log("ORDER_ENGINE", orderEngineAddr);
  console.log("COLLATERAL_MANAGER", collateralManagerAddr);
  console.log("LOAN_NFT", loanNftAddr);

  const ACTION_ADD_WHITELIST = key("ADD_WHITELIST");
  const ACTION_UPDATE_PRICE = key("UPDATE_PRICE");
  const ACTION_SET_PARAMETER = key("SET_PARAMETER");
  const ACTION_DEPOSIT = key("DEPOSIT");
  const ACTION_ORDER_CREATE = key("ORDER_CREATE");
  const ACTION_BORROW = key("BORROW");

  const requireRole = async (role: string, who: string, label: string) => {
    const has = await acm.hasRole(role, who);
    if (has) return;
    throw new Error(
      `[AccessControl] Missing role for ${label}. ` +
        `role=${role} who=${who}. ` +
        `Production-like mode: this script does NOT auto-grant roles. ` +
        `Grant roles first (see scripts/tests/README.md).`
    );
  };

  // Deployer roles required for this script's setup actions (whitelist/price/config).
  await requireRole(ACTION_ADD_WHITELIST, deployer.address, "deployer ACTION_ADD_WHITELIST");
  await requireRole(ACTION_UPDATE_PRICE, deployer.address, "deployer ACTION_UPDATE_PRICE");
  await requireRole(ACTION_SET_PARAMETER, deployer.address, "deployer ACTION_SET_PARAMETER");

  // Module roles required for finalizeMatch -> order creation -> LoanNFT mint path.
  await requireRole(ACTION_ORDER_CREATE, CONTRACT_ADDRESSES.VaultBusinessLogic, "VaultBusinessLogic ACTION_ORDER_CREATE");
  await requireRole(ACTION_DEPOSIT, CONTRACT_ADDRESSES.VaultBusinessLogic, "VaultBusinessLogic ACTION_DEPOSIT");
  await requireRole(ACTION_BORROW, orderEngineAddr, "OrderEngine ACTION_BORROW (LoanNFT minter)");

  // ============ Production-like preflight checks (no auto-config) ============
  // 1) AssetWhitelist must allow the debt/collateral token used by the flow.
  if (!(await aw.isAssetAllowed(usdc.target))) {
    throw new Error(
      `[Config] AssetWhitelist is missing token ${usdc.target}. ` +
        `Pre-config required: call AssetWhitelist.addAllowedAsset(${usdc.target}) via governance.`
    );
  }

  // 2) PriceOracle must have an active config and a fresh, valid price.
  //    This smoke does not auto-configure assets or push prices.
  {
    const cfg = await po.getAssetConfig(usdc.target);
    if (!cfg.isActive) {
      throw new Error(
        `[Config] PriceOracle asset is not active for ${usdc.target}. ` +
          `Pre-config required: call PriceOracle.configureAsset(${usdc.target}, "usd-coin", 8, 3600) via governance.`
      );
    }
    try {
      // Will revert if price is invalid/stale/not supported.
      await po.getPrice(usdc.target);
    } catch (e: any) {
      throw new Error(
        `[Config] PriceOracle.getPrice(${usdc.target}) is not usable (stale/invalid/missing). ` +
          `Pre-config required: ensure price updater feeds a fresh price (or updatePrice via authorized updater). ` +
          `Raw error: ${String(e?.message ?? e)}`
      );
    }
  }

  // 3) FeeRouter must already support the token (no auto-add in smoke).
  if (!(await feeRouter.isTokenSupported(usdc.target))) {
    throw new Error(
      `[Config] FeeRouter does not support token ${usdc.target}. ` +
        `Pre-config required: call FeeRouter.addSupportedToken(${usdc.target}) via governance.`
    );
  }

  await usdc.connect(deployer).transfer(borrower.address, ethers.parseUnits("20000", 6));
  await usdc.connect(deployer).transfer(lender.address, ethers.parseUnits("20000", 6));
  await usdc.connect(deployer).transfer(keeper.address, ethers.parseUnits("20000", 6));

  const collateralAmt = ethers.parseUnits("1000", 6);
  await usdc.connect(borrower).approve(collateralManagerAddr, collateralAmt);
  await vaultCore.connect(borrower).deposit(usdc.target, collateralAmt);

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
    salt: ethers.keccak256(ethers.toUtf8Bytes("smoke-borrow-salt-1")),
  };

  const lendIntent = {
    lenderSigner: lender.address,
    asset: usdc.target,
    amount: borrowAmt,
    minTermDays: 1,
    maxTermDays: 30,
    minRateBps: 0n,
    expireAt,
    salt: ethers.keccak256(ethers.toUtf8Bytes("smoke-lend-salt-1")),
  };

  await usdc.connect(lender).approve(CONTRACT_ADDRESSES.VaultBusinessLogic, borrowAmt);
  const lendHash = buildLendIntentHash(lendIntent);
  await vbl.connect(lender).reserveForLending(lender.address, usdc.target, borrowAmt, lendHash);

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
  const tx = await vbl.connect(deployer).finalizeMatch(
    borrowIntent,
    [lendIntent],
    sigBorrower,
    [sigLender]
  );
  const receipt = await tx.wait();

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
  if (orderId === null) throw new Error("LoanOrderCreated not found");

  const borrowerTokensAfter = await loanNft.getUserTokens(borrower.address);
  const newTokenId = borrowerTokensAfter.find((t) => !borrowerTokensBefore.includes(t));
  console.log("orderId", orderId.toString());
  console.log("LoanNFT tokenId", newTokenId?.toString());
  console.log("borrower", borrower.address);
  console.log("keeper", keeper.address);

  const termSec = BigInt(termDays) * ONE_DAY;
  const createdBlock = await ethers.provider.getBlock(receipt!.blockNumber);
  const maturity = BigInt(createdBlock!.timestamp) + termSec;
  await ethers.provider.send("evm_increaseTime", [Number(termSec + 60n)]);
  await ethers.provider.send("evm_mine", []);

  const nowAfter = (await ethers.provider.getBlock("latest"))!.timestamp;
  console.log("order maturity", maturity.toString());
  console.log("now", nowAfter.toString(), "(overdue=true)");
  console.log("");
  console.log("Next:");
  console.log(
    `ORDER_ID=${orderId.toString()} pnpm -s exec hardhat run "scripts/tests/funds-flow-smoke-local.ts" --network localhost`
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
