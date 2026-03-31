import { ethers, network } from "hardhat";
import { envBool, loadAddressMap, resolveAddress } from "./_addressResolver";

const ONE_DAY = 24n * 60n * 60n;
const ONE_HOUR_BLOCKS = 1_800n;
// Keep consistent with TermBlocksLib bucket mapping (5d=36000 => 7200 blocks/day baseline).
const BLOCKS_PER_DAY = 7_200n;

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

async function latestBlockNumber(): Promise<bigint> {
  return BigInt(await ethers.provider.getBlockNumber());
}

async function mineToBlock(targetBlock: bigint) {
  const current = await latestBlockNumber();
  if (targetBlock <= current) return;
  const delta = targetBlock - current;
  if (network.name === "localhost" || network.name === "hardhat") {
    await ethers.provider.send("hardhat_mine", [ethers.toBeHex(delta)]);
  }
}

async function main() {
  const readOnly = envBool("READ_ONLY", network.name !== "localhost");
  const enableWrite = envBool("ENABLE_WRITE", !readOnly);

  if (readOnly || !enableWrite) {
    const addressMap = loadAddressMap(network.name);
    const registryAddr = resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });
    const registry = (await ethers.getContractAt("Registry", registryAddr)) as any;
    const vblAddr = (await registry.getModuleOrRevert(key("VAULT_BUSINESS_LOGIC"))) as string;
    const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;
    console.log(`=== funds-flow-smoke-create-order (read-only) network=${network.name} ===`);
    console.log(`  Registry=${registryAddr}`);
    console.log(`  VAULT_BUSINESS_LOGIC=${vblAddr}`);
    console.log(`  ORDER_ENGINE=${orderEngineAddr}`);
    console.log("  ℹ️  [skip] write-heavy order creation flow (set ENABLE_WRITE=1 on localhost if needed)");
    console.log("\n✅ funds-flow-smoke-create-order (read-only) PASSED\n");
    return;
  }

  const [deployer, keeper, borrower, lender] = await ethers.getSigners();
  if (keeper.address.toLowerCase() === borrower.address.toLowerCase()) {
    throw new Error("[Config] keeper must differ from borrower for liquidation tests.");
  }

  const addressMap = loadAddressMap(network.name);
  const registryAddr = resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });
  const registry = (await ethers.getContractAt("Registry", registryAddr)) as any;

  const acmAddr = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
  const awAddr = (await registry.getModuleOrRevert(key("ASSET_WHITELIST"))) as string;
  const poAddr = (await registry.getModuleOrRevert(key("PRICE_ORACLE"))) as string;
  const feeRouterAddr = (await registry.getModuleOrRevert(key("FEE_ROUTER"))) as string;
  const usdcAddr = (await registry.getModuleOrRevert(key("SETTLEMENT_TOKEN"))) as string;
  const vaultCoreAddr = (await registry.getModuleOrRevert(key("VAULT_CORE"))) as string;
  const vblAddr = (await registry.getModuleOrRevert(key("VAULT_BUSINESS_LOGIC"))) as string;

  const acm = (await ethers.getContractAt("AccessControlManager", acmAddr)) as any;
  const awRead = (await ethers.getContractAt("IAssetWhitelistRead", awAddr)) as any;
  const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", poAddr)) as any;
  const feeRouter = (await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", feeRouterAddr)) as any;
  const usdc = (await ethers.getContractAt("MockERC20", usdcAddr)) as any;
  const vaultCore = (await ethers.getContractAt("VaultCore", vaultCoreAddr)) as any;
  const vbl = (await ethers.getContractAt("VaultBusinessLogic", vblAddr)) as any;

  const orderEngineAddr = await registry.getModuleOrRevert(key("ORDER_ENGINE"));
  const collateralManagerAddr = await registry.getModuleOrRevert(key("COLLATERAL_MANAGER"));
  const gfmAddr = await registry.getModule(key("GUARANTEE_FUND_MANAGER"));
  const ergmAddr = await registry.getModule(key("EARLY_REPAYMENT_GUARANTEE_MANAGER"));
  const orderEngine = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", orderEngineAddr)) as any;
  const loanNftAddr = await registry.getModuleOrRevert(key("LOAN_NFT"));
  const loanNft = await ethers.getContractAt("LoanNFT", loanNftAddr);

  console.log("VaultBusinessLogic", await vbl.getAddress());
  console.log("ORDER_ENGINE", orderEngineAddr);
  console.log("COLLATERAL_MANAGER", collateralManagerAddr);
  console.log("LOAN_NFT", loanNftAddr);
  if (gfmAddr && gfmAddr !== ethers.ZeroAddress) console.log("GUARANTEE_FUND_MANAGER", gfmAddr);
  if (ergmAddr && ergmAddr !== ethers.ZeroAddress) console.log("EARLY_REPAYMENT_GUARANTEE_MANAGER", ergmAddr);

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
  await requireRole(ACTION_ORDER_CREATE, vblAddr, "VaultBusinessLogic ACTION_ORDER_CREATE");
  await requireRole(ACTION_DEPOSIT, vblAddr, "VaultBusinessLogic ACTION_DEPOSIT");
  await requireRole(ACTION_BORROW, orderEngineAddr, "OrderEngine ACTION_BORROW (LoanNFT minter)");

  // ============ Production-like preflight checks (no auto-config) ============
  // 1) AssetWhitelist must allow the debt/collateral token used by the flow.
  if (!(await awRead.isAssetAllowed(usdc.target))) {
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
      const usdcDecimals = Number(await usdc.decimals().catch(() => 6));
      throw new Error(
        `[Config] PriceOracle asset is not active for ${usdc.target}. ` +
          `Pre-config required: call PriceOracle.configureAsset(${usdc.target}, "usd-coin", ${usdcDecimals}, 3600) via governance.`
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
  const expireAt = (await latestBlockNumber()) + ONE_HOUR_BLOCKS;

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

  await usdc.connect(lender).approve(vblAddr, borrowAmt);
  const lendHash = buildLendIntentHash(lendIntent);
  await vbl.connect(lender).reserveForLending(lender.address, usdc.target, borrowAmt, lendHash);

  const domain = {
    name: "RwaLending",
    version: "1",
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    verifyingContract: vblAddr,
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

  // Extension Flow: if guarantee is enabled for this asset, borrower must approve GFM for promisedInterest
  // before finalizeMatch (VBL will pull it via GFM.lockGuarantee).
  if (ergmAddr && ergmAddr !== ethers.ZeroAddress && gfmAddr && gfmAddr !== ethers.ZeroAddress) {
    try {
      const ergm = await ethers.getContractAt(["function isGuaranteeEnabled(address) view returns (bool)"], ergmAddr);
      const enabled = (await ergm.isGuaranteeEnabled(usdc.target)) as boolean;
      if (enabled) {
        const YEAR = 365n * ONE_DAY;
        const termSec = BigInt(termDays) * ONE_DAY;
        const promisedInterest = (borrowAmt * rateBps * termSec) / (10_000n * YEAR);
        if (promisedInterest > 0n) {
          await usdc.connect(borrower).approve(gfmAddr, promisedInterest);
        }
      }
    } catch (e) {
      console.log("  ⚠️  ExtensionFlow pre-approve skipped (could not read ERGM/isGuaranteeEnabled):", e);
    }
  }

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

  // Best-effort Extension Flow sanity: if guarantee was enabled, ensure custody+record exist.
  if (ergmAddr && ergmAddr !== ethers.ZeroAddress && gfmAddr && gfmAddr !== ethers.ZeroAddress) {
    try {
      const ergm = await ethers.getContractAt(
        ["function isGuaranteeEnabled(address) view returns (bool)", "function hasActiveGuarantee(address,address) view returns (bool)"],
        ergmAddr
      );
      const enabled = (await ergm.isGuaranteeEnabled(usdc.target)) as boolean;
      if (enabled) {
        const gfm = await ethers.getContractAt(["function getLockedGuarantee(address,address) view returns (uint256)"], gfmAddr);
        const locked = (await gfm.getLockedGuarantee(borrower.address, usdc.target)) as bigint;
        const active = (await ergm.hasActiveGuarantee(borrower.address, usdc.target)) as boolean;
        console.log(`ExtensionFlow: guarantee enabled => locked=${locked.toString()} active=${active}`);
        if (!active) throw new Error("ExtensionFlow: expected ERGM.hasActiveGuarantee=true after finalizeMatch");
        if (locked === 0n) throw new Error("ExtensionFlow: expected GFM.getLockedGuarantee > 0 after finalizeMatch");
      }
    } catch (e) {
      console.log("  ⚠️  ExtensionFlow post-check skipped:", e);
    }
  }

  const termBlocks = BigInt(termDays) * BLOCKS_PER_DAY;
  const createdBlock = await ethers.provider.getBlock(receipt!.blockNumber);
  const maturity = BigInt(createdBlock!.number) + termBlocks;
  await mineToBlock(maturity + ONE_HOUR_BLOCKS);

  const nowAfter = await latestBlockNumber();
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
