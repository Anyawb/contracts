import fs from "fs";
import path from "path";
import { spawnSync } from "node:child_process";

import { ethers, network } from "hardhat";

import { envStr, loadAddressMap, resolveAddress } from "../tests/_addressResolver";
import {
  BORROW_INTENT_TYPES,
  LEND_INTENT_TYPES,
  buildLendIntentHash,
  getAssetBootstrapPriceUsd8,
  parseLoanOrderId,
} from "../tests/live-test/_mockLiveUtils";
import { runViewPreflight } from "./utils/view-preflight";

type MockAssetPackAsset = {
  id: string;
  name: string;
  symbol: string;
  kind: "mock-erc20" | "rwa-token";
  decimals: number;
  initialSupply: string;
  sourceId: string;
  maxPriceAge: number;
  active: boolean;
  bootstrapPriceUsd8?: string;
  defaultPriceUsd8?: string;
  address: string;
};

type MockAssetPack = {
  settlementToken: string;
  assets: MockAssetPackAsset[];
};

const BLOCKS_PER_DAY = 7_200n;
const ONE_HOUR_BLOCKS = 1_800n;
const ONE_DAY = 24n * 60n * 60n;

function key(name: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

function assertOk(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function loadMockAssetPack(): MockAssetPack {
  const explicit = envStr("MOCK_ASSET_PACK_OUTPUT");
  const packFile = explicit
    ? path.isAbsolute(explicit)
      ? explicit
      : path.join(process.cwd(), explicit)
    : path.join(process.cwd(), "deployments", `mock-assets.${network.name}.json`);

  if (!fs.existsSync(packFile)) {
    throw new Error(`missing mock asset pack: ${packFile}`);
  }

  return JSON.parse(fs.readFileSync(packFile, "utf8")) as MockAssetPack;
}

function parseSymbols(raw: string | undefined, defaults: string[]): string[] {
  if (!raw) return defaults;
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

async function assertPackAssetsDeployed(assets: MockAssetPackAsset[]) {
  for (const asset of assets) {
    const code = await ethers.provider.getCode(asset.address);
    if (code === "0x") {
      throw new Error(
        `mock asset ${asset.symbol} has no code at ${asset.address}. Run: pnpm -s exec hardhat run scripts/deploy/deploy-mock-asset-pack.ts --network ${network.name}`,
      );
    }
  }
}

function isTransientRpcError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /ECONNRESET|ECONNREFUSED|UND_ERR_HEADERS_TIMEOUT|headers timeout|socket hang up/i.test(message);
}

async function assertPackAssetsDeployedWithRetry(assets: MockAssetPackAsset[], attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await assertPackAssetsDeployed(assets);
      return;
    } catch (error) {
      if (attempt >= attempts || !isTransientRpcError(error)) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[mock-pack] transient RPC failure during code check (${attempt}/${attempts}): ${message}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
}

function redeployMockAssetPack() {
  const result = spawnSync(
    "pnpm",
    ["-s", "exec", "hardhat", "run", "scripts/deploy/deploy-mock-asset-pack.ts", "--network", network.name],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
    },
  );

  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");

  if (result.status !== 0) {
    throw new Error(`deploy-mock-asset-pack failed with exit=${result.status ?? 1}`);
  }
}

async function ensureMockAssetPackReady(pack: MockAssetPack, symbols: string[]) {
  const wanted = new Set(symbols.map((symbol) => symbol.toLowerCase()));
  const targets = pack.assets.filter((asset) => wanted.has(asset.symbol.toLowerCase()));

  await assertPackAssetsDeployedWithRetry(targets).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[mock-pack] stale or missing localhost mock asset pack detected: ${message}`);
    console.warn("[mock-pack] redeploying scripts/deploy/deploy-mock-asset-pack.ts and refreshing addresses...");
    redeployMockAssetPack();
  });

  const refreshed = loadMockAssetPack();
  const refreshedTargets = refreshed.assets.filter((asset) => wanted.has(asset.symbol.toLowerCase()));
  await assertPackAssetsDeployedWithRetry(refreshedTargets);
  return refreshed;
}

function calcTotalDue(principal: bigint, rateBps: bigint, termBlocks: bigint): bigint {
  const denom = 365n * BLOCKS_PER_DAY * 10_000n;
  const interest = (principal * rateBps * termBlocks) / denom;
  return principal + interest;
}

function calcUtilizationWad(totalCollateral: bigint, totalDebt: bigint) {
  if (totalCollateral === 0n) return 0n;
  return (totalDebt * 10n ** 18n) / totalCollateral;
}

async function ensureRole(acm: any, role: string, who: string) {
  if (!(await acm.hasRole(role, who))) {
    await (await acm.grantRole(role, who)).wait();
  }
}

async function ensureAssetConfigured(params: {
  awRead: any;
  awAdmin: any;
  feeRouter: any;
  priceOracle: any;
  asset: MockAssetPackAsset;
  blockNumber: number;
}) {
  const { awRead, awAdmin, feeRouter, priceOracle, asset, blockNumber } = params;
  if (!(await awRead.isAssetAllowed(asset.address))) {
    await (await awAdmin.addAllowedAsset(asset.address)).wait();
  }
  const assetConfig = await priceOracle.getAssetConfig(asset.address);
  if (!assetConfig.isActive) {
    await (
      await priceOracle.configureAsset(
        asset.address,
        asset.sourceId,
        asset.decimals,
        asset.maxPriceAge,
      )
    ).wait();
  }
  await (
    await priceOracle.updatePrice(asset.address, ethers.parseUnits(getAssetBootstrapPriceUsd8(asset as any), 8), blockNumber)
  ).wait();
  if (!(await feeRouter.isTokenSupported(asset.address))) {
    await (await feeRouter.addSupportedToken(asset.address)).wait();
  }
}

async function buildActorPairs(deployer: any, existingActors: any[], pairCount: number) {
  const pairs: Array<{ borrower: any; lender: any }> = [];
  let index = 0;

  while (pairs.length < pairCount) {
    const borrower = existingActors[index];
    const lender = existingActors[index + 1];
    if (borrower && lender) {
      pairs.push({ borrower, lender });
      index += 2;
      continue;
    }

    const borrowerWallet = ethers.Wallet.createRandom().connect(ethers.provider);
    const lenderWallet = ethers.Wallet.createRandom().connect(ethers.provider);
    await (await deployer.sendTransaction({ to: borrowerWallet.address, value: ethers.parseEther("10") })).wait();
    await (await deployer.sendTransaction({ to: lenderWallet.address, value: ethers.parseEther("10") })).wait();
    pairs.push({ borrower: borrowerWallet, lender: lenderWallet });
  }

  return pairs;
}

async function ensureWhitelistedParticipants(registry: any, deployer: any, pairs: Array<{ borrower: any; lender: any }>) {
  const whitelistRegistryAddr = (await registry.getModuleOrRevert(key("WHITELIST_REGISTRY"))) as string;
  const whitelistRegistry = (await ethers.getContractAt("WhitelistRegistry", whitelistRegistryAddr)) as any;
  const participants = Array.from(new Set(pairs.flatMap(({ borrower, lender }) => [borrower.address, lender.address])));
  const missing: string[] = [];

  for (const account of participants) {
    if (!(await whitelistRegistry.isWhitelisted(account))) {
      missing.push(account);
    }
  }

  if (missing.length === 1) {
    await (await whitelistRegistry.connect(deployer).addAddress(missing[0])).wait();
  } else if (missing.length > 1) {
    await (await whitelistRegistry.connect(deployer).batchAddAddresses(missing)).wait();
  }

  for (const account of participants) {
    assertOk(await whitelistRegistry.isWhitelisted(account), `[WhitelistRegistry] participant not registered: ${account}`);
  }

  console.log(`WhitelistParticipants=${participants.length}`);
}

async function primeViewCache(
  deployer: any,
  collateralManager: any,
  lendingEngine: any,
  viewCache: any,
  asset: string,
) {
  const totalCollateral = (await collateralManager.getTotalCollateralByAsset(asset)) as bigint;
  const totalDebt = (await lendingEngine.getTotalDebtByAsset(asset)) as bigint;
  const utilization = calcUtilizationWad(totalCollateral, totalDebt);
  await (await viewCache.connect(deployer).setSystemStatus(asset, totalCollateral, totalDebt, utilization)).wait();
  const [status, valid] = (await viewCache.getSystemStatus(asset)) as [any, boolean];
  assertOk(valid, `ViewCache invalid after prime for ${asset}`);
  assertOk(BigInt(status.totalCollateral ?? status[0] ?? 0) === totalCollateral, `ViewCache collateral mismatch for ${asset}`);
  assertOk(BigInt(status.totalDebt ?? status[1] ?? 0) === totalDebt, `ViewCache debt mismatch for ${asset}`);
}

async function main() {
  if (network.name !== "localhost") {
    throw new Error("e2e-localhost-multi-stablecoin-views.ts only supports --network localhost");
  }

  const signers = await ethers.getSigners();
  if (signers.length < 9) {
    throw new Error(`expected at least 9 localhost signers, got ${signers.length}`);
  }

  const [deployer, ...actors] = signers;
  let pack = loadMockAssetPack();
  const stablecoinSymbols = parseSymbols(envStr("MULTI_STABLECOIN_SYMBOLS"), ["mUSDC", "mUSDT", "mHKD", "mSGD"]);
  const collateralSymbols = parseSymbols(
    envStr("MULTI_COLLATERAL_SYMBOLS") ?? envStr("MULTI_RWA_SYMBOLS"),
    pack.assets.filter((asset) => asset.kind === "rwa-token").map((asset) => asset.symbol),
  );
  pack = await ensureMockAssetPackReady(pack, [...stablecoinSymbols, ...collateralSymbols]);

  const addressMap = loadAddressMap(network.name);
  const registryAddr = resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });
  const registry = (await ethers.getContractAt("Registry", registryAddr)) as any;

  const acmAddr = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
  const awAddr = (await registry.getModuleOrRevert(key("ASSET_WHITELIST"))) as string;
  const priceOracleAddr = (await registry.getModuleOrRevert(key("PRICE_ORACLE"))) as string;
  const feeRouterAddr = (await registry.getModuleOrRevert(key("FEE_ROUTER"))) as string;
  const vaultCoreAddr = (await registry.getModuleOrRevert(key("VAULT_CORE"))) as string;
  const vblAddr = (await registry.getModuleOrRevert(key("VAULT_BUSINESS_LOGIC"))) as string;
  const vleAddr = (await registry.getModuleOrRevert(key("LENDING_ENGINE"))) as string;
  const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;
  const collateralManagerAddr = (await registry.getModuleOrRevert(key("COLLATERAL_MANAGER"))) as string;
  const settlementManagerAddr = (await registry.getModuleOrRevert(key("SETTLEMENT_MANAGER"))) as string;
  const valuationViewAddr = (await registry.getModuleOrRevert(key("VALUATION_ORACLE_VIEW"))) as string;
  const positionViewAddr = (await registry.getModuleOrRevert(key("POSITION_VIEW"))) as string;
  const userViewAddr = (await registry.getModuleOrRevert(key("USER_VIEW"))) as string;
  const viewCacheAddr = (await registry.getModuleOrRevert(key("VIEW_CACHE"))) as string;
  const healthViewAddr = (await registry.getModuleOrRevert(key("HEALTH_VIEW"))) as string;
  const gfmAddr = (await registry.getModule(key("GUARANTEE_FUND_MANAGER"))) as string;
  const ergmAddr = (await registry.getModule(key("EARLY_REPAYMENT_GUARANTEE_MANAGER"))) as string;

  const acm = (await ethers.getContractAt("AccessControlManager", acmAddr)) as any;
  const awRead = (await ethers.getContractAt("IAssetWhitelistRead", awAddr)) as any;
  const awAdmin = (await ethers.getContractAt("IAssetWhitelistAdmin", awAddr)) as any;
  const priceOracle = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", priceOracleAddr)) as any;
  const feeRouter = (await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", feeRouterAddr)) as any;
  const vaultCore = (await ethers.getContractAt("VaultCore", vaultCoreAddr)) as any;
  const vbl = (await ethers.getContractAt("VaultBusinessLogic", vblAddr)) as any;
  const vle = (await ethers.getContractAt("VaultLendingEngine", vleAddr)) as any;
  const orderEngine = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", orderEngineAddr)) as any;
  const settlementManager = (await ethers.getContractAt(
    "src/Vault/liquidation/modules/SettlementManager.sol:SettlementManager",
    settlementManagerAddr,
  )) as any;
  const collateralManager = (await ethers.getContractAt(
    ["function getTotalCollateralByAsset(address asset) view returns (uint256)", "function getCollateral(address user,address asset) view returns (uint256)"],
    collateralManagerAddr,
  )) as any;
  const valuationView = (await ethers.getContractAt(
    ["function getAssetPrice(address asset) view returns (uint256,uint256,bool)"],
    valuationViewAddr,
  )) as any;
  const positionView = (await ethers.getContractAt(
    ["function getUserPositionWithMeta(address user,address asset) view returns (uint256,uint256,bool,uint256,uint256)"],
    positionViewAddr,
  )) as any;
  const userView = (await ethers.getContractAt(
    ["function getUserPosition(address user,address asset) view returns (uint256,uint256)"],
    userViewAddr,
  )) as any;
  const viewCache = (await ethers.getContractAt(
    [
      "function setSystemStatus(address asset,uint256 totalCollateral,uint256 totalDebt,uint256 utilizationRate)",
      "function getSystemStatus(address asset) view returns (tuple(uint256 totalCollateral,uint256 totalDebt,uint256 utilizationRate,uint256 updateBlock,bool isValid),bool)",
    ],
    viewCacheAddr,
  )) as any;
  const healthView = (await ethers.getContractAt(
    ["function getUserHealthFactorWithMeta(address user) view returns (uint256,bool,uint256)"],
    healthViewAddr,
  )) as any;
  const ergm = ergmAddr && ergmAddr !== ethers.ZeroAddress
    ? ((await ethers.getContractAt(["function isGuaranteeEnabled(address) view returns (bool)"], ergmAddr)) as any)
    : null;

  const ACTION_ADD_WHITELIST = key("ADD_WHITELIST");
  const ACTION_UPDATE_PRICE = key("UPDATE_PRICE");
  const ACTION_SET_PARAMETER = key("SET_PARAMETER");
  const ACTION_DEPOSIT = key("DEPOSIT");
  const ACTION_ORDER_CREATE = key("ORDER_CREATE");
  const ACTION_BORROW = key("BORROW");
  const ACTION_REPAY = key("REPAY");

  await ensureRole(acm.connect(deployer), ACTION_ADD_WHITELIST, deployer.address);
  await ensureRole(acm.connect(deployer), ACTION_UPDATE_PRICE, deployer.address);
  await ensureRole(acm.connect(deployer), ACTION_SET_PARAMETER, deployer.address);
  await ensureRole(acm.connect(deployer), ACTION_ORDER_CREATE, vblAddr);
  await ensureRole(acm.connect(deployer), ACTION_DEPOSIT, vblAddr);
  await ensureRole(acm.connect(deployer), ACTION_BORROW, orderEngineAddr);

  const stablecoinAssets = stablecoinSymbols.map((symbol) => {
    const asset = pack.assets.find((item) => item.symbol.toLowerCase() === symbol.toLowerCase());
    assertOk(asset, `stablecoin ${symbol} not found in mock asset pack`);
    return asset;
  });
  const collateralAssets = collateralSymbols.map((symbol) => {
    const asset = pack.assets.find((item) => item.symbol.toLowerCase() === symbol.toLowerCase());
    assertOk(asset, `collateral ${symbol} not found in mock asset pack`);
    assertOk(asset.kind === "rwa-token", `collateral ${symbol} must be a rwa-token`);
    return asset;
  });
  const actorPairs = await buildActorPairs(deployer, actors, collateralAssets.length * stablecoinAssets.length);
  await ensureWhitelistedParticipants(registry, deployer, actorPairs);

  const blockNumber = await ethers.provider.getBlockNumber();
  for (const asset of collateralAssets) {
    await ensureAssetConfigured({ awRead, awAdmin: awAdmin.connect(deployer), feeRouter: feeRouter.connect(deployer), priceOracle: priceOracle.connect(deployer), asset, blockNumber });
  }
  for (const asset of stablecoinAssets) {
    await ensureAssetConfigured({ awRead, awAdmin: awAdmin.connect(deployer), feeRouter: feeRouter.connect(deployer), priceOracle: priceOracle.connect(deployer), asset, blockNumber });
  }

  await runViewPreflight({
    registryAddr,
    acmAddr,
    adminSigner: deployer,
    assetForPriceCheck: stablecoinAssets[0].address,
    ensureViewPushRole: true,
    ensureHealthPushDeps: true,
  });

  if (await settlementManager.requireFullRepayRelease()) {
    await (await settlementManager.connect(deployer).setRequireFullRepayRelease(false)).wait();
  }

  const domain = {
    name: "RwaLending",
    version: "1",
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    verifyingContract: vblAddr,
  } as const;

  console.log("=== Multi-RWA Multi-Stablecoin Strict E2E ===");
  console.log(`Registry=${registryAddr}`);
  console.log(`Collaterals=${collateralAssets.map((asset) => `${asset.symbol}:${asset.address}`).join(", ")}`);

  let pairIndex = 0;
  for (const collateralAsset of collateralAssets) {
    for (const borrowAsset of stablecoinAssets) {
      const { borrower, lender } = actorPairs[pairIndex];
      pairIndex += 1;

      await ensureRole(acm.connect(deployer), ACTION_REPAY, borrower.address);

      const collateralToken = (await ethers.getContractAt("MockERC20", collateralAsset.address)) as any;
      const debtToken = (await ethers.getContractAt("MockERC20", borrowAsset.address)) as any;

      const collateralAmount = ethers.parseUnits("1000", collateralAsset.decimals);
      const borrowAmount = ethers.parseUnits("500", borrowAsset.decimals);
      const termDays = 5;
      const rateBps = 1000n;
      const expireAt = BigInt(await ethers.provider.getBlockNumber()) + ONE_HOUR_BLOCKS;

      await (await collateralToken.connect(deployer).transfer(borrower.address, collateralAmount)).wait();
      await (await debtToken.connect(deployer).transfer(lender.address, borrowAmount * 2n)).wait();
      await (await debtToken.connect(deployer).transfer(borrower.address, borrowAmount)).wait();

      await (await collateralToken.connect(borrower).approve(collateralManagerAddr, collateralAmount)).wait();
      await (await vaultCore.connect(borrower).deposit(collateralAsset.address, collateralAmount)).wait();

      const borrowIntent = {
        borrower: borrower.address,
        collateralAsset: collateralAsset.address,
        collateralAmount,
        borrowAsset: borrowAsset.address,
        amount: borrowAmount,
        termDays,
        rateBps,
        expireAt,
        salt: ethers.keccak256(ethers.toUtf8Bytes(`strict-matrix-borrow-${collateralAsset.symbol}-${borrowAsset.symbol}-${pairIndex}`)),
      };
      const lendIntent = {
        lenderSigner: lender.address,
        asset: borrowAsset.address,
        amount: borrowAmount,
        minTermDays: 1,
        maxTermDays: 30,
        minRateBps: 0n,
        expireAt,
        salt: ethers.keccak256(ethers.toUtf8Bytes(`strict-matrix-lend-${collateralAsset.symbol}-${borrowAsset.symbol}-${pairIndex}`)),
      };

      await (await debtToken.connect(lender).approve(vblAddr, borrowAmount)).wait();
      await (await vbl.connect(lender).reserveForLending(lender.address, borrowAsset.address, borrowAmount, buildLendIntentHash(lendIntent))).wait();

      if (ergm && gfmAddr && gfmAddr !== ethers.ZeroAddress) {
        const guaranteeEnabled = (await ergm.isGuaranteeEnabled(borrowAsset.address)) as boolean;
        if (guaranteeEnabled) {
          const promisedInterest = (borrowAmount * rateBps * BigInt(termDays) * ONE_DAY) / (10_000n * 365n * ONE_DAY);
          if (promisedInterest > 0n) {
            await (await debtToken.connect(borrower).approve(gfmAddr, promisedInterest)).wait();
          }
        }
      }

      const sigBorrower = await borrower.signTypedData(domain, BORROW_INTENT_TYPES as any, borrowIntent as any);
      const sigLender = await lender.signTypedData(domain, LEND_INTENT_TYPES as any, lendIntent as any);

      const finalizeReceipt = await (
        await vbl.connect(deployer).finalizeMatch(borrowIntent, [lendIntent], sigBorrower, [sigLender])
      ).wait();
      const orderId = parseLoanOrderId(finalizeReceipt, orderEngine);

      await primeViewCache(deployer, collateralManager, vle, viewCache, borrowAsset.address);
      await primeViewCache(deployer, collateralManager, vle, viewCache, collateralAsset.address);

      const ledgerCollateral = (await collateralManager.getCollateral(borrower.address, borrowAsset.address)) as bigint;
      const ledgerDebt = (await vle.getDebt(borrower.address, borrowAsset.address)) as bigint;
      const totalDebtValueBefore = (await vle.getUserTotalDebtValue(borrower.address)) as bigint;
      const [positionCollateral, positionDebt, positionValid] = (await positionView.getUserPositionWithMeta(
        borrower.address,
        borrowAsset.address,
      )) as [bigint, bigint, boolean, bigint, bigint];
      const [userCollateral, userDebt] = (await userView.getUserPosition(borrower.address, borrowAsset.address)) as [bigint, bigint];
      const [healthFactor, healthValid] = (await healthView.getUserHealthFactorWithMeta(borrower.address)) as [bigint, boolean, bigint];
      const [systemStatus, systemValid] = (await viewCache.getSystemStatus(borrowAsset.address)) as [any, boolean];
      const [price, priceBlock, priceValid] = (await valuationView.getAssetPrice(borrowAsset.address)) as [bigint, bigint, boolean];

      assertOk(priceValid && price > 0n && priceBlock > 0n, `${collateralAsset.symbol}/${borrowAsset.symbol}: invalid valuation price`);
      assertOk(positionValid, `${collateralAsset.symbol}/${borrowAsset.symbol}: PositionView invalid after finalizeMatch`);
      assertOk(positionCollateral === ledgerCollateral, `${collateralAsset.symbol}/${borrowAsset.symbol}: PositionView collateral mismatch`);
      assertOk(positionDebt === ledgerDebt, `${collateralAsset.symbol}/${borrowAsset.symbol}: PositionView debt mismatch`);
      assertOk(userCollateral === ledgerCollateral, `${collateralAsset.symbol}/${borrowAsset.symbol}: UserView collateral mismatch`);
      assertOk(userDebt === ledgerDebt, `${collateralAsset.symbol}/${borrowAsset.symbol}: UserView debt mismatch`);
      assertOk(healthValid, `${collateralAsset.symbol}/${borrowAsset.symbol}: HealthView invalid after finalizeMatch`);
      assertOk(healthFactor > 0n, `${collateralAsset.symbol}/${borrowAsset.symbol}: HealthView returned zero health factor`);
      assertOk(systemValid, `${collateralAsset.symbol}/${borrowAsset.symbol}: ViewCache invalid after prime`);
      assertOk(BigInt(systemStatus.totalDebt ?? systemStatus[1] ?? 0) > 0n, `${collateralAsset.symbol}/${borrowAsset.symbol}: ViewCache totalDebt should be non-zero after finalizeMatch`);
      assertOk(totalDebtValueBefore > 0n, `${collateralAsset.symbol}/${borrowAsset.symbol}: totalDebtValue should be non-zero after finalizeMatch`);

      const totalDue = calcTotalDue(borrowAmount, rateBps, BigInt(termDays) * BLOCKS_PER_DAY);
      await (await debtToken.connect(borrower).approve(vaultCoreAddr, totalDue)).wait();
      await (await vaultCore.connect(borrower).repay(orderId, borrowAsset.address, totalDue)).wait();

      await primeViewCache(deployer, collateralManager, vle, viewCache, borrowAsset.address);
      await primeViewCache(deployer, collateralManager, vle, viewCache, collateralAsset.address);

      const ledgerDebtAfter = (await vle.getDebt(borrower.address, borrowAsset.address)) as bigint;
      const totalDebtValueAfter = (await vle.getUserTotalDebtValue(borrower.address)) as bigint;
      const [postPositionCollateral, postPositionDebt, postPositionValid] = (await positionView.getUserPositionWithMeta(
        borrower.address,
        borrowAsset.address,
      )) as [bigint, bigint, boolean, bigint, bigint];
      const [postUserCollateral, postUserDebt] = (await userView.getUserPosition(borrower.address, borrowAsset.address)) as [bigint, bigint];
      const [postHealthFactor, postHealthValid] = (await healthView.getUserHealthFactorWithMeta(borrower.address)) as [bigint, boolean, bigint];
      const [postSystemStatus, postSystemValid] = (await viewCache.getSystemStatus(borrowAsset.address)) as [any, boolean];

      assertOk(postPositionValid, `${collateralAsset.symbol}/${borrowAsset.symbol}: PositionView invalid after repay`);
      assertOk(postPositionDebt === ledgerDebtAfter, `${collateralAsset.symbol}/${borrowAsset.symbol}: PositionView debt mismatch after repay`);
      assertOk(postPositionDebt === 0n, `${collateralAsset.symbol}/${borrowAsset.symbol}: PositionView debt not cleared after repay`);
      assertOk(postUserCollateral === postPositionCollateral, `${collateralAsset.symbol}/${borrowAsset.symbol}: UserView collateral mismatch after repay`);
      assertOk(postUserDebt === postPositionDebt, `${collateralAsset.symbol}/${borrowAsset.symbol}: UserView debt mismatch after repay`);
      assertOk(postHealthValid, `${collateralAsset.symbol}/${borrowAsset.symbol}: HealthView invalid after repay`);
      assertOk(postHealthFactor > 0n, `${collateralAsset.symbol}/${borrowAsset.symbol}: HealthView returned zero after repay`);
      assertOk(postSystemValid, `${collateralAsset.symbol}/${borrowAsset.symbol}: ViewCache invalid after repay prime`);
      assertOk(BigInt(postSystemStatus.totalDebt ?? postSystemStatus[1] ?? 0) === 0n, `${collateralAsset.symbol}/${borrowAsset.symbol}: ViewCache totalDebt not cleared after repay`);
      assertOk(totalDebtValueAfter === 0n, `${collateralAsset.symbol}/${borrowAsset.symbol}: totalDebtValue not cleared after repay`);

      console.log(
        `  [ok] ${collateralAsset.symbol}/${borrowAsset.symbol} orderId=${orderId.toString()} pvDebt=${positionDebt.toString()} uvDebt=${userDebt.toString()} hf=${healthFactor.toString()} postHf=${postHealthFactor.toString()}`,
      );
    }
  }

  console.log("\n✅ Multi-RWA multi-stablecoin strict e2e PASSED\n");
}

main().catch((error) => {
  console.error("\n❌ e2e-localhost-multi-stablecoin-views FAILED\n");
  console.error(error);
  process.exit(1);
});