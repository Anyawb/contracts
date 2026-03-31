import fs from "fs";
import path from "path";

import { ethers, network } from "hardhat";

import { envStr, loadAddressMap, resolveAddress } from "./_addressResolver";
import {
  BORROW_INTENT_TYPES,
  LEND_INTENT_TYPES,
  buildLendIntentHash,
  getAssetBootstrapPriceUsd8,
  parseLoanOrderId,
} from "./live-test/_mockLiveUtils";
import { runViewPreflight } from "../e2e/utils/view-preflight";

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
  settlementToken?: boolean;
  address: string;
};

type MockAssetPack = {
  settlementToken: string;
  assets: MockAssetPackAsset[];
};

const ONE_DAY = 24n * 60n * 60n;
const BLOCKS_PER_DAY = 7_200n;
const ONE_HOUR_BLOCKS = 1_800n;

function key(name: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

function loadMockAssetPack(): MockAssetPack {
  const explicit = envStr("MOCK_ASSET_PACK_OUTPUT");
  const packFile = explicit
    ? path.isAbsolute(explicit)
      ? explicit
      : path.join(process.cwd(), explicit)
    : path.join(process.cwd(), "deployments", `mock-assets.${network.name}.json`);

  if (!fs.existsSync(packFile)) {
    throw new Error(
      `missing mock asset pack: ${packFile}. Run: pnpm -s exec hardhat run scripts/deploy/deploy-mock-asset-pack.ts --network ${network.name}`
    );
  }

  return JSON.parse(fs.readFileSync(packFile, "utf8")) as MockAssetPack;
}

function parseSymbols(raw: string | undefined, defaults: string[]): string[] {
  if (!raw) return defaults;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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

function calcTotalDue(principal: bigint, rateBps: bigint, termBlocks: bigint): bigint {
  const denom = 365n * BLOCKS_PER_DAY * 10_000n;
  const interest = (principal * rateBps * termBlocks) / denom;
  return principal + interest;
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
    await priceOracle.updatePrice(
      asset.address,
      ethers.parseUnits(getAssetBootstrapPriceUsd8(asset as any), 8),
      blockNumber,
    )
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
    if (!(await whitelistRegistry.isWhitelisted(account))) {
      throw new Error(`[WhitelistRegistry] participant not registered: ${account}`);
    }
  }

  console.log(`WhitelistParticipants=${participants.length}`);
}

async function main() {
  if (network.name !== "localhost") {
    throw new Error("smoke-multi-stablecoin-local.ts only supports --network localhost");
  }

  const signers = await ethers.getSigners();
  if (signers.length < 9) {
    throw new Error(`expected at least 9 localhost signers, got ${signers.length}`);
  }

  const [deployer, ...actors] = signers;
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
  const valuationView = (await ethers.getContractAt(
    ["function getAssetPrice(address asset) view returns (uint256,uint256,bool)"],
    valuationViewAddr,
  )) as any;
  const positionView = (await ethers.getContractAt(
    ["function getUserPositionWithMeta(address user,address asset) view returns (uint256,uint256,bool,uint256,uint256)"],
    positionViewAddr,
  )) as any;
  const ergm = ergmAddr && ergmAddr !== ethers.ZeroAddress
    ? ((await ethers.getContractAt(
        ["function isGuaranteeEnabled(address) view returns (bool)"],
        ergmAddr,
      )) as any)
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

  const pack = loadMockAssetPack();
  const stablecoinSymbols = parseSymbols(envStr("MULTI_STABLECOIN_SYMBOLS"), ["mUSDC", "mUSDT", "mHKD", "mSGD"]);
  const stablecoinAssets = stablecoinSymbols.map((symbol) => {
    const asset = pack.assets.find((item) => item.symbol.toLowerCase() === symbol.toLowerCase());
    if (!asset) {
      throw new Error(`stablecoin ${symbol} not found in mock asset pack`);
    }
    return asset;
  });

  const collateralSymbols = parseSymbols(
    envStr("MULTI_COLLATERAL_SYMBOLS") ?? envStr("MULTI_RWA_SYMBOLS"),
    pack.assets.filter((asset) => asset.kind === "rwa-token").map((asset) => asset.symbol),
  );
  const collateralAssets = collateralSymbols.map((symbol) => {
    const asset = pack.assets.find((item) => item.symbol.toLowerCase() === symbol.toLowerCase());
    if (!asset) {
      throw new Error(`collateral ${symbol} not found in mock asset pack`);
    }
    if (asset.kind !== "rwa-token") {
      throw new Error(`collateral ${symbol} must be a rwa-token`);
    }
    return asset;
  });
  const actorPairs = await buildActorPairs(deployer, actors, collateralAssets.length * stablecoinAssets.length);
  await assertPackAssetsDeployed([...collateralAssets, ...stablecoinAssets]);
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

  console.log("=== Multi-RWA Multi-Stablecoin Local Smoke ===");
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
        salt: ethers.keccak256(ethers.toUtf8Bytes(`matrix-borrow-${collateralAsset.symbol}-${borrowAsset.symbol}-${pairIndex}`)),
      };
      const lendIntent = {
        lenderSigner: lender.address,
        asset: borrowAsset.address,
        amount: borrowAmount,
        minTermDays: 1,
        maxTermDays: 30,
        minRateBps: 0n,
        expireAt,
        salt: ethers.keccak256(ethers.toUtf8Bytes(`matrix-lend-${collateralAsset.symbol}-${borrowAsset.symbol}-${pairIndex}`)),
      };

      await (await debtToken.connect(lender).approve(vblAddr, borrowAmount)).wait();
      const lendHash = buildLendIntentHash(lendIntent);
      await (await vbl.connect(lender).reserveForLending(lender.address, borrowAsset.address, borrowAmount, lendHash)).wait();

      const sigBorrower = await borrower.signTypedData(domain, BORROW_INTENT_TYPES as any, borrowIntent as any);
      const sigLender = await lender.signTypedData(domain, LEND_INTENT_TYPES as any, lendIntent as any);

      if (ergm && gfmAddr && gfmAddr !== ethers.ZeroAddress) {
        const guaranteeEnabled = (await ergm.isGuaranteeEnabled(borrowAsset.address)) as boolean;
        if (guaranteeEnabled) {
          const promisedInterest = (borrowAmount * rateBps * BigInt(termDays) * ONE_DAY) /
            (10_000n * 365n * ONE_DAY);
          if (promisedInterest > 0n) {
            await (await debtToken.connect(borrower).approve(gfmAddr, promisedInterest)).wait();
          }
        }
      }

      const finalizeReceipt = await (
        await vbl.connect(deployer).finalizeMatch(borrowIntent, [lendIntent], sigBorrower, [sigLender])
      ).wait();
      const orderId = parseLoanOrderId(finalizeReceipt, orderEngine);

      const [priceUsd8, priceBlock, priceValid] = (await valuationView.getAssetPrice(borrowAsset.address)) as [bigint, bigint, boolean];
      const [positionCollateral, positionDebt, positionValid] = (await positionView.connect(borrower).getUserPositionWithMeta(
        borrower.address,
        borrowAsset.address,
      )) as [bigint, bigint, boolean, bigint, bigint];
      const debtValueBefore = (await vle.getUserTotalDebtValue(borrower.address)) as bigint;

      if (!priceValid || priceUsd8 === 0n) {
        throw new Error(`${collateralAsset.symbol}/${borrowAsset.symbol}: valuation price is not valid`);
      }
      if (positionDebt !== borrowAmount) {
        throw new Error(`${collateralAsset.symbol}/${borrowAsset.symbol}: position debt mismatch ${positionDebt} != ${borrowAmount}`);
      }
      if (!positionValid) {
        throw new Error(`${collateralAsset.symbol}/${borrowAsset.symbol}: position view invalid after finalizeMatch`);
      }
      if (debtValueBefore === 0n) {
        throw new Error(`${collateralAsset.symbol}/${borrowAsset.symbol}: getUserTotalDebtValue returned 0 after finalizeMatch`);
      }

      const totalDue = calcTotalDue(borrowAmount, rateBps, BigInt(termDays) * BLOCKS_PER_DAY);
      await (await debtToken.connect(borrower).approve(vaultCoreAddr, totalDue)).wait();
      await (await vaultCore.connect(borrower).repay(orderId, borrowAsset.address, totalDue)).wait();

      const [postCollateral, postDebt] = (await positionView.connect(borrower).getUserPositionWithMeta(
        borrower.address,
        borrowAsset.address,
      )) as [bigint, bigint, boolean, bigint, bigint];
      const debtValueAfter = (await vle.getUserTotalDebtValue(borrower.address)) as bigint;

      if (postDebt !== 0n) {
        throw new Error(`${collateralAsset.symbol}/${borrowAsset.symbol}: debt not cleared after repay (${postDebt})`);
      }
      if (debtValueAfter !== 0n) {
        throw new Error(`${collateralAsset.symbol}/${borrowAsset.symbol}: USD-8 debt value not cleared after repay (${debtValueAfter})`);
      }

      console.log(
        [
          `  [ok] ${collateralAsset.symbol}/${borrowAsset.symbol}`,
          `price=${priceUsd8.toString()}`,
          `priceBlock=${priceBlock.toString()}`,
          `positionCollateral=${positionCollateral.toString()}`,
          `positionDebt=${positionDebt.toString()}`,
          `postCollateral=${postCollateral.toString()}`,
          `orderId=${orderId.toString()}`,
        ].join(" "),
      );
    }
  }

  console.log("\n✅ Multi-RWA multi-stablecoin local smoke PASSED\n");
}

main().catch((error) => {
  console.error("\n❌ smoke-multi-stablecoin-local FAILED\n");
  console.error(error);
  process.exit(1);
});