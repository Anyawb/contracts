import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

import { loadAddressMap, resolveAddress } from "../tests/_addressResolver";
import { fundErc20Users } from "./utils/fork-token-funding.ts";
import { runViewPreflight } from "./utils/view-preflight.ts";

const ONE_HOUR_BLOCKS = 1_800n;
const STALE_DEBT_MAX_AGE_BLOCKS = BigInt(process.env.E2E_TIER_BOUNDARY_DEBT_MAX_AGE_BLOCKS ?? "1");
const CRASHED_COLLATERAL_PRICE_PPM = BigInt(process.env.E2E_TIER_BOUNDARY_COLLATERAL_PRICE_PPM ?? "200000");

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function assertOk(cond: unknown, message: string): asserts cond {
  if (!cond) {
    throw new Error(message);
  }
}

function mkArtifactsWriter() {
  const outDir = path.join(__dirname, "artifacts");
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch {
    // ignore
  }
  return {
    writeJson: (name: string, data: unknown) => {
      const filePath = path.join(outDir, name);
      const replacer = (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value);
      fs.writeFileSync(filePath, `${JSON.stringify(data, replacer, 2)}\n`, "utf8");
      return filePath;
    },
  };
}

async function latestBlockNumber() {
  return BigInt(await ethers.provider.getBlockNumber());
}

async function mineToBlock(targetBlock: bigint) {
  const current = await latestBlockNumber();
  if (targetBlock <= current) {
    return;
  }
  const delta = targetBlock - current;
  try {
    await ethers.provider.send("hardhat_mine", [ethers.toBeHex(delta)]);
  } catch {
    for (let remaining = delta; remaining > 0n; remaining -= 1n) {
      await ethers.provider.send("evm_mine", []);
    }
  }
}

async function waitTx(txPromise: Promise<any>, label: string) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  assertOk(receipt, `${label}: missing receipt`);
  return receipt;
}

async function assertHasCode(address: string, label: string) {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") {
    throw new Error(`[TierBoundaryE2E] no bytecode at ${label}: ${address}`);
  }
}

function buildLendIntentHash(lendIntent: any) {
  const typeHash = ethers.keccak256(
    ethers.toUtf8Bytes(
      "LendIntent(address lenderSigner,address asset,uint256 amount,uint16 minTermDays,uint16 maxTermDays,uint256 minRateBps,uint256 expireAt,bytes32 salt)",
    ),
  );
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "address", "address", "uint256", "uint16", "uint16", "uint256", "uint256", "bytes32"],
      [
        typeHash,
        lendIntent.lenderSigner,
        lendIntent.asset,
        lendIntent.amount,
        lendIntent.minTermDays,
        lendIntent.maxTermDays,
        lendIntent.minRateBps,
        lendIntent.expireAt,
        lendIntent.salt,
      ],
    ),
  );
}

function extractOrderIdFromReceipt(receipt: any, orderEngine: any, orderEngineAddr: string): bigint | null {
  for (const log of receipt?.logs ?? []) {
    try {
      if (String(log.address ?? "").toLowerCase() !== orderEngineAddr.toLowerCase()) {
        continue;
      }
      const parsed = orderEngine.interface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "LoanOrderCreated") {
        return BigInt(parsed.args.orderId);
      }
    } catch {
      // ignore unrelated logs
    }
  }
  return null;
}

async function ensureRole(acm: any, admin: any, roleName: string, account: string) {
  const role = key(roleName);
  if (!((await acm.hasRole(role, account)) as boolean)) {
    await waitTx(acm.connect(admin).grantRole(role, account), `grantRole ${roleName}`);
  }
}

async function expectRevert(label: string, action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    console.log(`  [ExpectedRevert] ${label}: ${message}`);
    return message;
  }
  throw new Error(`${label}: expected revert`);
}

export async function runLocalhostTierBoundaryE2E() {
  const snapshot = await network.provider.send("evm_snapshot", []);
  const artifacts = mkArtifactsWriter();
  const out: Record<string, unknown> = {
    name: "localhost-tier-boundary",
    generatedAt: new Date().toISOString(),
    chainId: String((await ethers.provider.getNetwork()).chainId),
    staleDebtMaxAgeBlocks: STALE_DEBT_MAX_AGE_BLOCKS.toString(),
    crashedCollateralPricePpm: CRASHED_COLLATERAL_PRICE_PPM.toString(),
    steps: [],
  };

  try {
    const addressMap = loadAddressMap("localhost");
    const registryAddr = resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });
    await assertHasCode(registryAddr, "Registry");

    const [deployer, borrower, lender] = await ethers.getSigners();
    const registry = (await ethers.getContractAt(
      ["function getModuleOrRevert(bytes32) view returns (address)", "function getModule(bytes32) view returns (address)"],
      registryAddr,
    )) as any;

    const acmAddr = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
    const assetWhitelistAddr = (await registry.getModuleOrRevert(key("ASSET_WHITELIST"))) as string;
    const priceOracleAddr = (await registry.getModuleOrRevert(key("PRICE_ORACLE"))) as string;
    const feeRouterAddr = (await registry.getModuleOrRevert(key("FEE_ROUTER"))) as string;
    const settlementManagerAddr = (await registry.getModuleOrRevert(key("SETTLEMENT_MANAGER"))) as string;
    const vaultCoreAddr = (await registry.getModuleOrRevert(key("VAULT_CORE"))) as string;
    const vblAddr = (await registry.getModuleOrRevert(key("VAULT_BUSINESS_LOGIC"))) as string;
    const cmAddr = (await registry.getModuleOrRevert(key("COLLATERAL_MANAGER"))) as string;
    const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;
    const lendingEngineAddr = (await registry.getModuleOrRevert(key("LENDING_ENGINE"))) as string;
    const valuationViewAddr = (await registry.getModuleOrRevert(key("VALUATION_ORACLE_VIEW"))) as string;
    const settlementTokenAddr = (await registry.getModuleOrRevert(key("SETTLEMENT_TOKEN"))) as string;

    const acm = (await ethers.getContractAt("AccessControlManager", acmAddr)) as any;
    const assetWhitelistAdmin = (await ethers.getContractAt("IAssetWhitelistAdmin", assetWhitelistAddr)) as any;
    const assetWhitelistRead = (await ethers.getContractAt("IAssetWhitelistRead", assetWhitelistAddr)) as any;
    const priceOracle = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", priceOracleAddr)) as any;
    const feeRouter = (await ethers.getContractAt("FeeRouter", feeRouterAddr)) as any;
    const settlementManager = (await ethers.getContractAt(
      ["function settleOrLiquidate(uint256 orderId)"],
      settlementManagerAddr,
    )) as any;
    const vaultCore = (await ethers.getContractAt("VaultCore", vaultCoreAddr)) as any;
    const vbl = (await ethers.getContractAt("VaultBusinessLogic", vblAddr)) as any;
    const orderEngine = (await ethers.getContractAt(
      [
        "event LoanOrderCreated(uint256 indexed orderId,address indexed borrower,address indexed lender,uint256 principal)",
        "function getLoanOrderForView(uint256 orderId) view returns ((uint256 principal,uint256 rate,uint256 term,address borrower,address lender,address asset,uint256 startBlock,uint256 maturity,uint256 repaidAmount))",
        "function getOrderStatusForView(uint256 orderId) view returns (uint8)",
      ],
      orderEngineAddr,
    )) as any;
    const lendingEngine = (await ethers.getContractAt(
      [
        "function calculateDebtValue(address user,address asset) view returns (uint256)",
        "function calculateDebtValueBestEffort(address user,address asset) view returns (uint256)",
        "function calculateDebtValueStrict(address user,address asset) view returns (uint256)",
        "function getUserTotalDebtValue(address user) view returns (uint256)",
        "function getUserTotalDebtValueBestEffort(address user) view returns (uint256)",
        "function getUserTotalDebtValueStrict(address user) view returns (uint256)",
      ],
      lendingEngineAddr,
    )) as any;
    const valuationView = (await ethers.getContractAt(
      ["function getAssetPrice(address asset) view returns (uint256,uint256,bool)"],
      valuationViewAddr,
    )) as any;
    const settlementToken = (await ethers.getContractAt("MockERC20", settlementTokenAddr)) as any;

    await runViewPreflight({
      registryAddr,
      acmAddr,
      adminSigner: deployer,
      assetForPriceCheck: settlementTokenAddr,
    });

    await ensureRole(acm, deployer, "ADD_WHITELIST", deployer.address);
    await ensureRole(acm, deployer, "SET_PARAMETER", deployer.address);
    await ensureRole(acm, deployer, "UPDATE_PRICE", deployer.address);
    await ensureRole(acm, deployer, "ORDER_CREATE", vblAddr);
    await ensureRole(acm, deployer, "DEPOSIT", vblAddr);
    await ensureRole(acm, deployer, "BORROW", orderEngineAddr);
    await ensureRole(acm, deployer, "REPAY", settlementManagerAddr);
    await ensureRole(acm, deployer, "LIQUIDATE", deployer.address);
    await ensureRole(acm, deployer, "VIEW_SYSTEM_DATA", deployer.address);
    await ensureRole(acm, deployer, "VIEW_PRICE_DATA", deployer.address);
    await ensureRole(acm, deployer, "VIEW_RISK_DATA", deployer.address);

    if (!(await assetWhitelistRead.isAssetAllowed(settlementTokenAddr))) {
      await waitTx(assetWhitelistAdmin.connect(deployer).addAllowedAsset(settlementTokenAddr), "allow settlement token");
    }
    if (!(await feeRouter.isTokenSupported(settlementTokenAddr))) {
      await waitTx(feeRouter.connect(deployer).addSupportedToken(settlementTokenAddr), "support settlement token");
    }

    const settlementDecimals = Number(await settlementToken.decimals());
    await waitTx(
      priceOracle.connect(deployer).configureAsset(
        settlementTokenAddr,
        "usd-coin",
        settlementDecimals,
        Number(STALE_DEBT_MAX_AGE_BLOCKS),
      ),
      "configure settlement token with tight strict age",
    );
    await waitTx(
      priceOracle.connect(deployer).updatePrice(
        settlementTokenAddr,
        ethers.parseUnits("1", settlementDecimals),
        await ethers.provider.getBlockNumber(),
      ),
      "price settlement token bootstrap",
    );

    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const collateralToken = await tokenFactory.connect(deployer).deploy(
      "MockTier2BoundaryCollateral",
      "MT2BC",
      6,
      ethers.parseUnits("1000000000", 6),
    );
    await collateralToken.waitForDeployment();
    const collateralTokenAddr = await collateralToken.getAddress();

    if (!(await assetWhitelistRead.isAssetAllowed(collateralTokenAddr))) {
      await waitTx(assetWhitelistAdmin.connect(deployer).addAllowedAsset(collateralTokenAddr), "allow collateral token");
    }
    if (!(await feeRouter.isTokenSupported(collateralTokenAddr))) {
      await waitTx(feeRouter.connect(deployer).addSupportedToken(collateralTokenAddr), "support collateral token");
    }
    await waitTx(
      priceOracle.connect(deployer).configureAsset(collateralTokenAddr, "mock-tier1-collateral", 6, 3600),
      "configure collateral token",
    );
    await waitTx(
      priceOracle.connect(deployer).updatePrice(
        collateralTokenAddr,
        ethers.parseUnits("1", 6),
        await ethers.provider.getBlockNumber(),
      ),
      "price collateral token bootstrap",
    );

    await fundErc20Users({
      token: settlementToken,
      deployer,
      recipients: [borrower.address, lender.address],
      amount: ethers.parseUnits("500000", settlementDecimals),
      label: "tier-boundary settlement funding",
    });
    await fundErc20Users({
      token: collateralToken,
      deployer,
      recipients: [borrower.address],
      amount: ethers.parseUnits("500000", 6),
      label: "tier-boundary collateral funding",
    });

    const principal = ethers.parseUnits("1000", settlementDecimals);
    const collateralAmount = ethers.parseUnits("3000", 6);
    const termDays = 5;
    const rateBps = 1000n;
    const expireAt = (await latestBlockNumber()) + ONE_HOUR_BLOCKS;

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

    const borrowIntent = {
      borrower: borrower.address,
      collateralAsset: collateralTokenAddr,
      collateralAmount,
      borrowAsset: settlementTokenAddr,
      amount: principal,
      termDays,
      rateBps,
      expireAt,
      salt: ethers.keccak256(ethers.toUtf8Bytes(`tier-boundary-borrow-${Date.now()}`)),
    };
    const lendIntent = {
      lenderSigner: lender.address,
      asset: settlementTokenAddr,
      amount: principal,
      minTermDays: termDays,
      maxTermDays: termDays,
      minRateBps: 0n,
      expireAt,
      salt: ethers.keccak256(ethers.toUtf8Bytes(`tier-boundary-lend-${Date.now()}`)),
    };

    await waitTx(settlementToken.connect(lender).approve(vblAddr, principal), "approve reserve");
    await waitTx(
      vbl.connect(lender).reserveForLending(lender.address, settlementTokenAddr, principal, buildLendIntentHash(lendIntent)),
      "reserve for lending",
    );
    await waitTx(collateralToken.connect(borrower).approve(cmAddr, collateralAmount), "approve collateral");
    await waitTx(vaultCore.connect(borrower).deposit(collateralTokenAddr, collateralAmount), "deposit collateral");

    const sigBorrower = await borrower.signTypedData(domain, typesBorrow as any, borrowIntent as any);
    const sigLender = await lender.signTypedData(domain, typesLend as any, lendIntent as any);
    const finalizeReceipt = await waitTx(
      vbl.connect(deployer).finalizeMatch(borrowIntent, [lendIntent], sigBorrower, [sigLender]),
      "finalizeMatch",
    );

    const orderId = extractOrderIdFromReceipt(finalizeReceipt, orderEngine, orderEngineAddr);
    assertOk(orderId !== null, "LoanOrderCreated not found in finalize receipt");

    const orderBefore = await orderEngine.getLoanOrderForView(orderId);
    await mineToBlock(BigInt(orderBefore.maturity) + 1n);

    const currentBlock = await ethers.provider.getBlockNumber();
    const crashedCollateralPrice = (ethers.parseUnits("1", 6) * CRASHED_COLLATERAL_PRICE_PPM) / 1_000_000n;
    assertOk(crashedCollateralPrice > 0n, "crashed collateral price must be positive");
    await waitTx(
      priceOracle.connect(deployer).updatePrice(collateralTokenAddr, crashedCollateralPrice, currentBlock),
      "refresh collateral price only",
    );

    const stalePriceReason = await expectRevert(
      "strict debt asset price must be unavailable after max age elapses",
      async () => priceOracle.getPrice(settlementTokenAddr),
    );

    const [valuationPrice, valuationBlock, valuationValid] = (await valuationView.getAssetPrice(settlementTokenAddr)) as [bigint, bigint, boolean];
    const [collateralPrice, collateralBlock, collateralValid] = (await valuationView.getAssetPrice(collateralTokenAddr)) as [bigint, bigint, boolean];

    const legacyDebtValue = (await lendingEngine.calculateDebtValue(borrower.address, settlementTokenAddr)) as bigint;
    const bestEffortDebtValue = (await lendingEngine.calculateDebtValueBestEffort(borrower.address, settlementTokenAddr)) as bigint;
    const legacyTotalDebtValue = (await lendingEngine.getUserTotalDebtValue(borrower.address)) as bigint;
    const bestEffortTotalDebtValue = (await lendingEngine.getUserTotalDebtValueBestEffort(borrower.address)) as bigint;

    const strictSingleReason = await expectRevert(
      "strict single-asset debt valuation must fail closed on stale authoritative price",
      async () => lendingEngine.calculateDebtValueStrict(borrower.address, settlementTokenAddr),
    );
    const strictTotalReason = await expectRevert(
      "strict total debt valuation must fail closed on stale authoritative price",
      async () => lendingEngine.getUserTotalDebtValueStrict(borrower.address),
    );
    const liquidationReason = await expectRevert(
      "settleOrLiquidate must fail closed when the debt asset is reference-only/best-effort only",
      async () => settlementManager.connect(deployer).settleOrLiquidate.staticCall(orderId),
    );

    const orderStatusAfter = (await orderEngine.getOrderStatusForView(orderId)) as bigint;

    assertOk(!valuationValid, "ValuationOracleView must mark stale debt asset price invalid");
    assertOk(valuationPrice === 0n, "ValuationOracleView should return zero price for stale debt asset");
    assertOk(valuationBlock === 0n, "ValuationOracleView should return block=0 for stale debt asset");
    assertOk(collateralValid, "control collateral price should remain valid");
    assertOk(collateralPrice > 0n, "control collateral price must stay positive");
    assertOk(collateralBlock > 0n, "control collateral block must stay positive");
    assertOk(bestEffortDebtValue > 0n, "best-effort single-asset valuation should remain non-zero for diagnostics");
    assertOk(bestEffortTotalDebtValue > 0n, "best-effort total valuation should remain non-zero for diagnostics");
    assertOk(legacyDebtValue === bestEffortDebtValue, "legacy calculateDebtValue must remain an alias of best-effort valuation");
    assertOk(legacyTotalDebtValue === bestEffortTotalDebtValue, "legacy getUserTotalDebtValue must remain an alias of best-effort total valuation");
    assertOk(orderStatusAfter === 0n, `automatic fail-closed path must leave order active, got ${orderStatusAfter.toString()}`);

    out.steps = [
      {
        step: "create-order",
        orderId: orderId.toString(),
        principal: principal.toString(),
        collateralAmount: collateralAmount.toString(),
      },
      {
        step: "strict-price-boundary",
        stalePriceReason,
        valuationValid,
        valuationPrice: valuationPrice.toString(),
        valuationBlock: valuationBlock.toString(),
        collateralValid,
        collateralPrice: collateralPrice.toString(),
        collateralBlock: collateralBlock.toString(),
      },
      {
        step: "best-effort-vs-strict",
        legacyDebtValue: legacyDebtValue.toString(),
        bestEffortDebtValue: bestEffortDebtValue.toString(),
        legacyTotalDebtValue: legacyTotalDebtValue.toString(),
        bestEffortTotalDebtValue: bestEffortTotalDebtValue.toString(),
        strictSingleReason,
        strictTotalReason,
      },
      {
        step: "automatic-path-fail-closed",
        liquidationReason,
        orderStatusAfter: orderStatusAfter.toString(),
      },
    ];

    const artifactPath = artifacts.writeJson(`tier-boundary.${Date.now()}.json`, out);
    console.log(`[E2E] tier boundary artifact: ${artifactPath}`);
  } catch (error) {
    const artifactPath = artifacts.writeJson(`tier-boundary.FAIL.${Date.now()}.json`, {
      ...out,
      error: error instanceof Error ? error.message : String(error),
    });
    console.error(`[E2E] tier boundary failed; artifact: ${artifactPath}`);
    throw error;
  } finally {
    await network.provider.send("evm_revert", [snapshot]);
  }
}

async function main() {
  await runLocalhostTierBoundaryE2E();
}

main().catch((error) => {
  console.error("\n❌ e2e-localhost-tier-boundary FAILED\n");
  console.error(error);
  process.exit(1);
});