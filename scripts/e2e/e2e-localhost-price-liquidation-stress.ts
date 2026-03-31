import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadAddressMap, resolveAddress } from "../tests/_addressResolver";
import { fundErc20Users } from "./utils/fork-token-funding.ts";
import { runViewPreflight } from "./utils/view-preflight.ts";
import { runRewardExtendedChecks } from "./utils/reward-extended-checks.ts";

const ONE_HOUR_BLOCKS = 1_800n;
const BLOCKS_PER_DAY = 7_200n;
const PRICE_DECIMALS = 8;
const PRICE_PPM = 1_000_000n;

const STRESS_MODE = (process.env.E2E_STRESS_MODE ?? "multi").toLowerCase();
const ASSET_COUNT = Number(process.env.E2E_STRESS_ASSET_COUNT ?? "2");
const LEVERAGE_CYCLES = Number(process.env.E2E_STRESS_LEVERAGE_CYCLES ?? "1");
const ROLL_RATIO_PPM = BigInt(process.env.E2E_STRESS_ROLL_RATIO_PPM ?? "950000");
const TERMS_DAYS_RAW = process.env.E2E_STRESS_TERMS_DAYS ?? "5,10";
const POSITION_USD_MIN = Number(process.env.E2E_STRESS_POSITION_USD_MIN ?? "1000");
const POSITION_USD_MAX = Number(process.env.E2E_STRESS_POSITION_USD_MAX ?? "1000000");
const COLLATERAL_RATIO_PPM = BigInt(process.env.E2E_STRESS_COLLATERAL_RATIO_PPM ?? "3000000");
const COLLATERAL_ASSET_MODE = (process.env.E2E_STRESS_COLLATERAL_ASSET_MODE ?? "settlement").toLowerCase();
const MULTI_TOTAL_ORDERS = Number(process.env.E2E_STRESS_MULTI_ORDERS ?? "16");
const MULTI_OSCILLATIONS = Number(process.env.E2E_STRESS_MULTI_OSCILLATIONS ?? "6");
const MULTI_LAG_ROUNDS = Number(process.env.E2E_STRESS_MULTI_LAG_ROUNDS ?? "1");
const MULTI_SHOCK_A_PPM = BigInt(process.env.E2E_STRESS_MULTI_SHOCK_A_PPM ?? "300000");
const MULTI_SHOCK_B_PPM = BigInt(process.env.E2E_STRESS_MULTI_SHOCK_B_PPM ?? "500000");
const MULTI_REBOUND_A_PPM = BigInt(process.env.E2E_STRESS_MULTI_REBOUND_A_PPM ?? "450000");
const MULTI_REBOUND_B_PPM = BigInt(process.env.E2E_STRESS_MULTI_REBOUND_B_PPM ?? "650000");
const MULTI_CRASH_A_PPM = BigInt(process.env.E2E_STRESS_MULTI_CRASH_A_PPM ?? "180000");
const MULTI_CRASH_B_PPM = BigInt(process.env.E2E_STRESS_MULTI_CRASH_B_PPM ?? "300000");
const MULTI_BORROWERS = Number(process.env.E2E_STRESS_MULTI_BORROWERS ?? "3");
const MULTI_LENDERS = Number(process.env.E2E_STRESS_MULTI_LENDERS ?? "3");
const GRIND_BORROWERS = Number(process.env.E2E_STRESS_GRIND_BORROWERS ?? "3");

const GRIND_ROUNDS = Number(process.env.E2E_STRESS_GRIND_ROUNDS ?? "10");
const GRIND_STEP_PPM = BigInt(process.env.E2E_STRESS_GRIND_STEP_PPM ?? "80000");
const GRIND_REBOUND_EVERY = Number(process.env.E2E_STRESS_GRIND_REBOUND_EVERY ?? "3");
const GRIND_REBOUND_PPM = BigInt(process.env.E2E_STRESS_GRIND_REBOUND_PPM ?? "120000");
const GRIND_TOTAL_ORDERS = Number(process.env.E2E_STRESS_GRIND_ORDERS ?? "12");

const STRICT_REWARD = (process.env.E2E_STRICT_REWARD ?? "0").toLowerCase() === "1";
const TRACK_GUARANTEE_PENALTY = (process.env.E2E_STRESS_TRACK_GUARANTEE_PENALTY ?? "1").toLowerCase() !== "0";
const ENABLE_GUARANTEE_EXTENSION_FLOW = (process.env.E2E_STRESS_ENABLE_GUARANTEE_FLOW ?? "1").toLowerCase() !== "0";

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function clampOrders(v: number) {
  if (!Number.isFinite(v) || v <= 0) return 1;
  return Math.floor(v);
}

function clampRatio(v: number, fallback: number) {
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.floor(v);
}

function clampUsd(v: number, fallback: number) {
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.floor(v);
}

function clampPpm(v: bigint, fallback: bigint) {
  if (v <= 0n) return fallback;
  return v;
}

function parseTerms(raw: string): number[] {
  const parsed = raw
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && v > 0);
  return parsed.length ? parsed : [5, 10];
}

function assertOk(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function isZeroAddr(addr: string | undefined | null): boolean {
  return !addr || addr === ethers.ZeroAddress;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fmtErr(e: any) {
  return e?.shortMessage ?? e?.message ?? String(e);
}

function mkArtifactsWriter() {
  const outDir = path.join(__dirname, "artifacts");
  const docDir = path.join(__dirname, "doc");
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch {
    // ignore
  }
  try {
    fs.mkdirSync(docDir, { recursive: true });
  } catch {
    // ignore
  }
  return {
    outDir,
    docDir,
    writeJson: (name: string, data: unknown) => {
      const p = path.join(outDir, name);
      const replacer = (_k: string, v: any) => (typeof v === "bigint" ? v.toString() : v);
      fs.writeFileSync(p, JSON.stringify(data, replacer, 2) + "\n", "utf8");
      return p;
    },
    writeDocJson: (name: string, data: unknown) => {
      const p = path.join(docDir, name);
      const replacer = (_k: string, v: any) => (typeof v === "bigint" ? v.toString() : v);
      fs.writeFileSync(p, JSON.stringify(data, replacer, 2) + "\n", "utf8");
      return p;
    },
  };
}

function summarizeStressScenario(scenario: any) {
  const orders = Array.isArray(scenario?.orders) ? scenario.orders : [];
  const executed = orders.filter((order: any) => !order?.skipped);
  const assetMap = new Map<string, { orders: number; skipped: number; liquidated: number; fallback: number; zeroVal: number }>();
  let principalUsdMin: bigint | null = null;
  let principalUsdMax: bigint | null = null;
  let fallbackLiquidations = 0;
  let zeroValuations = 0;

  for (const order of orders) {
    const asset = String(order?.asset ?? "");
    const bucket = assetMap.get(asset) ?? { orders: 0, skipped: 0, liquidated: 0, fallback: 0, zeroVal: 0 };
    bucket.orders += 1;
    if (order?.skipped) {
      bucket.skipped += 1;
    } else {
      bucket.liquidated += 1;
    }
    if (order?.fallbackLiquidation) {
      bucket.fallback += 1;
      fallbackLiquidations += 1;
    }

    const collateralSnapshots = Array.isArray(order?.collateralSnapshots) ? order.collateralSnapshots : [];
    const orderZeroVal = collateralSnapshots.some((snap: any) => String(snap?.valueUsd8 ?? "0") === "0");
    if (orderZeroVal) {
      bucket.zeroVal += 1;
      zeroValuations += 1;
    }

    assetMap.set(asset, bucket);

    const principalRaw = order?.principalUsd;
    const principal = typeof principalRaw === "string" || typeof principalRaw === "number" ? BigInt(principalRaw) : null;
    if (principal !== null) {
      if (principalUsdMin === null || principal < principalUsdMin) principalUsdMin = principal;
      if (principalUsdMax === null || principal > principalUsdMax) principalUsdMax = principal;
    }
  }

  const assets: Record<string, { orders: number; skipped: number; liquidated: number; fallback: number; zeroVal: number }> = {};
  for (const [asset, bucket] of assetMap.entries()) {
    assets[asset] = bucket;
  }

  const summary: Record<string, unknown> = {
    orders: orders.length,
    skipped: orders.length - executed.length,
    liquidated: executed.length,
    fallbackLiquidations,
    zeroValuations,
    assets,
  };

  if (principalUsdMin !== null) summary.principalUsdMin = principalUsdMin.toString();
  if (principalUsdMax !== null) summary.principalUsdMax = principalUsdMax.toString();
  if (scenario?.liquidationThreshold !== undefined) summary.liquidationThreshold = String(scenario.liquidationThreshold);
  if (scenario?.deepenedCrashRounds !== undefined) summary.deepenedCrashRounds = Number(scenario.deepenedCrashRounds);
  if (Array.isArray(scenario?.riskSamples)) summary.riskSamples = scenario.riskSamples;
  if (isPlainObject(scenario?.grind)) summary.grind = scenario.grind;

  return summary;
}

function buildStressLatestReport(data: any, artifactPath: string) {
  const scenarios = Array.isArray(data?.scenarios) ? data.scenarios : [];
  const summarizedScenarios: Record<string, unknown> = {};
  for (const scenario of scenarios) {
    const label = String(scenario?.label ?? "").trim();
    if (!label) continue;
    summarizedScenarios[label] = summarizeStressScenario(scenario);
  }

  return {
    generatedAt: data?.generatedAt ?? new Date().toISOString(),
    artifact: path.relative(__dirname, artifactPath).replaceAll("\\", "/"),
    config: data?.config ?? {},
    scenarios: summarizedScenarios,
  };
}

function formatPpm(ppm: bigint): string {
  if (ppm <= 0n) return "0";
  const whole = ppm / PRICE_PPM;
  const frac = ppm % PRICE_PPM;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracStr}`;
}

function ppmToPrice(ppm: bigint): bigint {
  return ethers.parseUnits(formatPpm(ppm), PRICE_DECIMALS);
}

async function latestBlockNumber(): Promise<bigint> {
  return BigInt(await ethers.provider.getBlockNumber());
}

async function mineToBlock(targetBlock: bigint) {
  const current = await latestBlockNumber();
  if (targetBlock <= current) return;
  const delta = targetBlock - current;
  await ethers.provider.send("hardhat_mine", [ethers.toBeHex(delta)]);
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

async function waitTx(p: Promise<any>, label: string) {
  const tx = await p;
  const rc = await tx.wait();
  assertOk(!!rc, `${label}: missing receipt`);
  assertOk(rc.status === 1, `${label}: tx failed (status=${String(rc.status)})`);
  return rc;
}

function pickSigner<T>(list: T[], idx: number, fallback: T): T {
  if (!list.length) return fallback;
  return list[idx % list.length];
}

function extractDataPushed(receipt: any, viewAddr: string) {
  const iface = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
  const out: Array<{ typeHash: string; payload: string }> = [];
  for (const log of receipt?.logs ?? []) {
    if (String(log.address).toLowerCase() !== viewAddr.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "DataPushed") {
        out.push({ typeHash: String(parsed.args.dataTypeHash), payload: String(parsed.args.payload) });
      }
    } catch {
      // ignore
    }
  }
  return out;
}

function seededValue(seed: number, min: number, max: number): number {
  if (max <= min) return min;
  const span = max - min;
  const n = (seed * 9301 + 49297) % 233280;
  return min + (n % span);
}

function scaleByPpm(value: bigint, ppm: bigint): bigint {
  return (value * ppm) / PRICE_PPM;
}

function calcTotalDue(principal: bigint, rateBps: bigint, termBlocks: bigint) {
  const denom = 365n * BLOCKS_PER_DAY * 10_000n;
  const interest = (principal * rateBps * termBlocks) / denom;
  return principal + interest;
}

function rollPrincipal(baseUsd: number, cycle: number, ratioPpm: bigint): bigint {
  let v = BigInt(Math.max(1, Math.floor(baseUsd)));
  for (let i = 0; i < cycle; i++) {
    v = scaleByPpm(v, ratioPpm);
    if (v <= 0n) return 1n;
  }
  return v;
}

async function main() {
  const snap = await network.provider.send("evm_snapshot", []);
  const artifacts = mkArtifactsWriter();
  const data: any = {
    name: "price-liquidation-stress",
    generatedAt: new Date().toISOString(),
    chainId: String((await ethers.provider.getNetwork()).chainId),
    rpcUrl: process.env.LOCALHOST_RPC_URL ?? "",
    scenarios: [],
  };

  try {
    if (!new Set(["multi", "grind", "multi+grind"]).has(STRESS_MODE)) {
      throw new Error(`E2E_STRESS_MODE must be one of: multi, grind, multi+grind (got ${STRESS_MODE})`);
    }
    if (!new Set(["settlement", "debt"]).has(COLLATERAL_ASSET_MODE)) {
      throw new Error(`E2E_STRESS_COLLATERAL_ASSET_MODE must be settlement|debt (got ${COLLATERAL_ASSET_MODE})`);
    }
    const allSigners = await ethers.getSigners();
    const [deployer, borrower, lender] = allSigners;
    const addressMap = loadAddressMap("localhost");
    const registryAddr = resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });

    console.log("=== E2E Price/Liquidation Stress ===\n");

    const registry = (await ethers.getContractAt("Registry", registryAddr)) as any;
    const acmAddr = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
    const assetWhitelistAddr = (await registry.getModuleOrRevert(key("ASSET_WHITELIST"))) as string;
    const priceOracleAddr = (await registry.getModuleOrRevert(key("PRICE_ORACLE"))) as string;
    const feeRouterAddr = (await registry.getModuleOrRevert(key("FEE_ROUTER"))) as string;
    const settlementManagerAddr = (await registry.getModuleOrRevert(key("SETTLEMENT_MANAGER"))) as string;
    const liquidationManagerAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_MANAGER"))) as string;
    const liquidationRiskManagerAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_RISK_MANAGER"))) as string;
    const guaranteeFundManagerAddr = (await registry.getModuleOrRevert(key("GUARANTEE_FUND_MANAGER"))) as string;
    const ergmAddr = (await registry.getModuleOrRevert(key("EARLY_REPAYMENT_GUARANTEE_MANAGER"))) as string;
    const vaultCoreAddr = (await registry.getModuleOrRevert(key("VAULT_CORE"))) as string;
    const vblAddr = (await registry.getModuleOrRevert(key("VAULT_BUSINESS_LOGIC"))) as string;
    const cmAddr = (await registry.getModuleOrRevert(key("COLLATERAL_MANAGER"))) as string;
    const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;
    const vaultLendingEngineAddr = (await registry.getModuleOrRevert(key("LENDING_ENGINE"))) as string;
    const healthViewAddr = (await registry.getModuleOrRevert(key("HEALTH_VIEW"))) as string;
    const liquidatorViewAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_VIEW"))) as string;
    const positionViewAddr = (await registry.getModuleOrRevert(key("POSITION_VIEW"))) as string;
    const valuationOracleViewAddr = (await registry.getModuleOrRevert(key("VALUATION_ORACLE_VIEW"))) as string;

    const rewardViewAddr = (await registry.getModule(key("REWARD_VIEW"))) as string;
    const rewardAccrualManagerAddr = (await registry.getModule(key("REWARD_ACCRUAL_MANAGER"))) as string;
    const easyEmissionConfigAddr = (await registry.getModule(key("EASY_EMISSION_CONFIG"))) as string;
    const rewardManagerCoreAddr = (await registry.getModuleOrRevert(key("REWARD_MANAGER_CORE"))) as string;

    const rewardView = !isZeroAddr(rewardViewAddr) ? (((await ethers.getContractAt("RewardView", rewardViewAddr)) as any) ?? null) : null;
    const easyEmissionConfig = !isZeroAddr(easyEmissionConfigAddr)
      ? (((await ethers.getContractAt("EasyEmissionConfig", easyEmissionConfigAddr)) as any) ?? null)
      : null;
    const easyTokenAddr = (await registry.getModule(key("EASY_TOKEN"))) as string;
    const easyToken =
      !isZeroAddr(easyTokenAddr)
        ? (((await ethers.getContractAt("src/Token/EasyToken.sol:EasyToken", easyTokenAddr)) as any) ?? null)
        : null;

    const acm = (await ethers.getContractAt("AccessControlManager", acmAddr)) as any;
    const awRead = (await ethers.getContractAt("IAssetWhitelistRead", assetWhitelistAddr)) as any;
    const awAdmin = (await ethers.getContractAt("IAssetWhitelistAdmin", assetWhitelistAddr)) as any;
    const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", priceOracleAddr)) as any;
    const feeRouter = (await ethers.getContractAt("FeeRouter", feeRouterAddr)) as any;
    const settlementManager = (await ethers.getContractAt("SettlementManager", settlementManagerAddr)) as any;
    const liquidationManager = (await ethers.getContractAt(
      "src/Vault/liquidation/modules/LiquidationManager.sol:LiquidationManager",
      liquidationManagerAddr
    )) as any;
    const liquidationRiskManager = (await ethers.getContractAt("LiquidationRiskManager", liquidationRiskManagerAddr)) as any;
    const ergm = (await ethers.getContractAt(
      "src/Vault/modules/EarlyRepaymentGuaranteeManager.sol:EarlyRepaymentGuaranteeManager",
      ergmAddr
    )) as any;
    const vaultCore = (await ethers.getContractAt("VaultCore", vaultCoreAddr)) as any;
    const cm = (await ethers.getContractAt("CollateralManager", cmAddr)) as any;
    const orderEngine = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", orderEngineAddr)) as any;
    const vbl = (await ethers.getContractAt("VaultBusinessLogic", vblAddr)) as any;
    const vle = (await ethers.getContractAt("src/Vault/modules/VaultLendingEngine.sol:VaultLendingEngine", vaultLendingEngineAddr)) as any;
    const healthView = (await ethers.getContractAt("HealthView", healthViewAddr)) as any;
    const liquidatorView = (await ethers.getContractAt("LiquidatorView", liquidatorViewAddr)) as any;
    const positionView = (await ethers.getContractAt("PositionView", positionViewAddr)) as any;
    const valuationOracleView = (await ethers.getContractAt(
      "src/Vault/view/modules/ValuationOracleView.sol:ValuationOracleView",
      valuationOracleViewAddr
    )) as any;

    const rewardAccrualManager = !isZeroAddr(rewardAccrualManagerAddr)
      ? (((await ethers.getContractAt("RewardAccrualManager", rewardAccrualManagerAddr)) as any) ?? null)
      : null;

    const assetAddr = (await registry.getModuleOrRevert(key("SETTLEMENT_TOKEN"))) as string;
    const usdc = (await ethers.getContractAt("MockERC20", assetAddr)) as any;

    const clampMultiOrders = clampOrders(MULTI_TOTAL_ORDERS);
    const clampGrindOrders = clampOrders(GRIND_TOTAL_ORDERS);
    const multiBorrowers = clampRatio(MULTI_BORROWERS, 1);
    const multiLenders = clampRatio(MULTI_LENDERS, 1);
    const grindBorrowers = clampRatio(GRIND_BORROWERS, 1);
    const assetCount = clampRatio(ASSET_COUNT, 2);
    const leverageCycles = clampRatio(LEVERAGE_CYCLES, 1);
    const rollRatio = clampPpm(ROLL_RATIO_PPM, 950000n);
    const termDaysList = parseTerms(TERMS_DAYS_RAW);
    const usdMin = clampUsd(POSITION_USD_MIN, 1000);
    const usdMax = clampUsd(POSITION_USD_MAX, 1000000);
    const collateralRatio = clampPpm(COLLATERAL_RATIO_PPM, 3000000n);

    const allowedAssets = (await awRead.getAllowedAssets()) as string[];
    const assets: string[] = [assetAddr];
    for (const addr of allowedAssets) {
      if (assets.length >= assetCount) break;
      if (addr.toLowerCase() === assetAddr.toLowerCase()) continue;
      assets.push(addr);
    }

    const deployedAssets: string[] = [];
    if (assets.length < assetCount) {
      const factory = await ethers.getContractFactory("MockERC20");
      const initialSupply = ethers.parseUnits("1000000000", 6);
      while (assets.length < assetCount) {
        const idx = assets.length + 1;
        const symbol = `RWA${idx}`;
        const token = await factory.connect(deployer).deploy(`Mock${symbol}`, symbol, 6, initialSupply);
        await token.waitForDeployment();
        const addr = await token.getAddress();
        assets.push(addr);
        deployedAssets.push(addr);
      }
    }

    await runViewPreflight({
      registryAddr,
      acmAddr,
      adminSigner: deployer,
      assetForPriceCheck: assetAddr,
    });

    const ensureRole = async (roleName: string, who: string | any) => {
      const whoAddr = await ethers.resolveAddress(who);
      const role = key(roleName);
      if (!(await acm.hasRole(role, whoAddr))) {
        await (await acm.grantRole(role, whoAddr)).wait();
      }
    };

    await ensureRole("ADD_WHITELIST", deployer.address);
    await ensureRole("UPDATE_PRICE", deployer.address);
    await ensureRole("ORDER_CREATE", vblAddr);
    await ensureRole("DEPOSIT", vblAddr);
    await ensureRole("BORROW", orderEngineAddr);
    await ensureRole("REPAY", settlementManagerAddr);
    await ensureRole("VIEW_SYSTEM_DATA", settlementManagerAddr);
    await ensureRole("ACTION_VIEW_PUSH", liquidationManagerAddr);
    await ensureRole("ACTION_VIEW_PUSH", settlementManagerAddr);
    await ensureRole("VIEW_RISK_DATA", vaultLendingEngineAddr);
    await ensureRole("LIQUIDATE", deployer.address);
    await ensureRole("LIQUIDATE", liquidationManagerAddr);
    await ensureRole("LIQUIDATE", settlementManagerAddr);
    await ensureRole("VIEW_SYSTEM_DATA", liquidationManagerAddr);
    await ensureRole("VIEW_RISK_DATA", liquidationManagerAddr);
    await ensureRole("VIEW_USER_DATA", liquidationRiskManagerAddr);
    await ensureRole("ACTION_SET_PARAMETER", deployer.address);
    await ensureRole("VIEW_RISK_DATA", deployer.address);
    await ensureRole("VIEW_PRICE_DATA", deployer.address);

    if (!(await awRead.isAssetAllowed(assetAddr))) {
      await waitTx(awAdmin.connect(deployer).addAllowedAsset(assetAddr), "addAllowedAsset");
    }

    if (deployedAssets.length) {
      await waitTx(awAdmin.connect(deployer).batchAddAllowedAssets(deployedAssets), "batchAddAllowedAssets stress");
    }

    for (const asset of assets) {
      if (!(await feeRouter.isTokenSupported(asset))) {
        await waitTx(feeRouter.connect(deployer).addSupportedToken(asset), "addSupportedToken");
      }
    }

    // Disable early-repayment guarantees for stress runs to allow borrower reuse.
    for (const asset of assets) {
      await waitTx(ergm.connect(deployer).setGuaranteeEnabled(asset, false), "disable guarantee");
    }

    const tokenByAsset = new Map<string, any>();
    const decimalsByAsset = new Map<string, number>();

    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      const token = await ethers.getContractAt("MockERC20", asset);
      tokenByAsset.set(asset, token);
      const decimals = Number(await token.decimals());
      decimalsByAsset.set(asset, decimals);
      const cfg = await po.getAssetConfig(asset);
      if (!cfg.isActive) {
        const label = i === 0 ? "usd-coin" : `rwa-${i + 1}`;
        await waitTx(po.connect(deployer).configureAsset(asset, label, decimals, 3600), `configureAsset ${label}`);
      }
    }

    const nowBlock = await latestBlockNumber();
    for (const asset of assets) {
      await waitTx(po.connect(deployer).updatePrice(asset, ppmToPrice(PRICE_PPM), nowBlock), `updatePrice ${asset}`);
    }

    // Assert PriceOracle is seeded post-updatePrice (preflight happens earlier, so fallback may show 0/0 there).
    for (const asset of assets) {
      const [p, b, valid] = (await valuationOracleView.getAssetPrice(asset)) as [bigint, bigint, boolean];
      assertOk(valid, `post-seed price invalid: asset=${asset}`);
      assertOk(p > 0n, `post-seed price is 0: asset=${asset}`);
      assertOk(b > 0n, `post-seed price block is 0: asset=${asset}`);
    }

    const rateBps = 1000n;

    // fund borrower + lender
    const fundUsers = async (token: any, users: string[], amount: bigint, label: string) => {
      await fundErc20Users({ token, deployer, recipients: users, amount, label });
    };

    const baseBorrowers = allSigners.slice(1);
    const baseLenders = allSigners.slice(1 + Math.min(baseBorrowers.length, allSigners.length - 2));
    const borrowNeed = Math.max(1, clampMultiOrders + clampGrindOrders);
    const lendNeed = Math.max(1, multiLenders);

    const makeWallets = async (count: number) => {
      const wallets: any[] = [];
      for (let i = 0; i < count; i++) {
        const w = ethers.Wallet.createRandom().connect(ethers.provider);
        await waitTx(deployer.sendTransaction({ to: w.address, value: ethers.parseEther("2") }), "fund wallet");
        wallets.push(w);
      }
      return wallets;
    };

    const borrowerList = [...baseBorrowers];
    if (borrowerList.length < borrowNeed) {
      const extra = await makeWallets(borrowNeed - borrowerList.length);
      borrowerList.push(...extra);
    }

    const lenderList = [...baseLenders];
    if (lenderList.length < lendNeed) {
      const extra = await makeWallets(lendNeed - lenderList.length);
      lenderList.push(...extra);
    }
    const fallbacks = { borrower, lender };

    const uniqueUsers = [...new Set([...borrowerList, ...lenderList].map((s) => s.address))];

    const ensureWhitelisted = async (accounts: string[], label: string) => {
      const whitelistRegistryAddr = (await registry.getModuleOrRevert(key("WHITELIST_REGISTRY"))) as string;
      const whitelistRegistry = (await ethers.getContractAt("WhitelistRegistry", whitelistRegistryAddr)) as any;
      const participants = Array.from(new Set(accounts.map((account) => ethers.getAddress(account))));
      const missing: string[] = [];
      for (const account of participants) {
        if (!(await whitelistRegistry.isWhitelisted(account))) missing.push(account);
      }
      if (missing.length === 1) {
        await waitTx(whitelistRegistry.connect(deployer).addAddress(missing[0]), `${label}: whitelist addAddress`);
      } else if (missing.length > 1) {
        await waitTx(
          whitelistRegistry.connect(deployer).batchAddAddresses(missing),
          `${label}: whitelist batchAddAddresses`
        );
      }
      for (const account of participants) {
        assertOk(await whitelistRegistry.isWhitelisted(account), `${label}: participant not whitelisted (${account})`);
      }
      console.log(`  ✅ WhitelistRegistry preflight passed (${label}): ${participants.length} accounts registered`);
    };

    await ensureWhitelisted(uniqueUsers, "stress participants");

    for (const asset of assets) {
      const token = tokenByAsset.get(asset);
      const decimals = decimalsByAsset.get(asset) ?? 6;
      await fundUsers(token, uniqueUsers, ethers.parseUnits("50000000", decimals), `fund ${asset.slice(0, 6)}`);
    }

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

    const finalizeOne = async (
      saltSuffix: string,
      assetForLoan: string,
      collateralAsset: string,
      borrowerSigner: any,
      lenderSigner: any,
      principalAmt: bigint,
      collateralForLoan: bigint,
      termDays: number
    ) => {
      const expireAt = (await latestBlockNumber()) + ONE_HOUR_BLOCKS;
      const borrowIntent = {
        borrower: borrowerSigner.address,
        collateralAsset,
        collateralAmount: collateralForLoan,
        borrowAsset: assetForLoan,
        amount: principalAmt,
        termDays,
        rateBps,
        expireAt,
        salt: ethers.keccak256(ethers.toUtf8Bytes(`stress-borrow-${saltSuffix}`)),
      };

      const lendIntent = {
        lenderSigner: lenderSigner.address,
        asset: assetForLoan,
        amount: principalAmt,
        minTermDays: borrowIntent.termDays,
        maxTermDays: borrowIntent.termDays,
        minRateBps: 0n,
        expireAt,
        salt: ethers.keccak256(ethers.toUtf8Bytes(`stress-lend-${saltSuffix}`)),
      };

      const token = tokenByAsset.get(assetForLoan);
      const collateralToken = tokenByAsset.get(collateralAsset);
      const allowance = (await collateralToken.allowance(borrowerSigner.address, guaranteeFundManagerAddr)) as bigint;
      if (allowance < principalAmt) {
        await waitTx(
          collateralToken.connect(borrowerSigner).approve(guaranteeFundManagerAddr, ethers.MaxUint256),
          "approve GFM"
        );
      }
      await waitTx(token.connect(lenderSigner).approve(vblAddr, principalAmt), "approve reserve");
      const lendHash = buildLendIntentHash(lendIntent);
      await waitTx(
        vbl.connect(lenderSigner).reserveForLending(lenderSigner.address, assetForLoan, principalAmt, lendHash),
        "reserveForLending"
      );

      await waitTx(collateralToken.connect(borrowerSigner).approve(cmAddr, collateralForLoan), "approve collateral");
      await waitTx(vaultCore.connect(borrowerSigner).deposit(collateralAsset, collateralForLoan), "deposit");

      const postCollateral = (await cm.getCollateral(borrowerSigner.address, collateralAsset)) as bigint;
      assertOk(postCollateral >= collateralForLoan, "collateral deposit missing or insufficient");

      const sigBorrower = await borrowerSigner.signTypedData(domain, typesBorrow as any, borrowIntent as any);
      const sigLender = await lenderSigner.signTypedData(domain, typesLend as any, lendIntent as any);

      const rc = await waitTx(vbl.connect(deployer).finalizeMatch(borrowIntent, [lendIntent], sigBorrower, [sigLender]), "finalizeMatch");

      let orderId: bigint | null = null;
      for (const log of rc.logs) {
        try {
          if (String(log.address).toLowerCase() !== String(orderEngineAddr).toLowerCase()) continue;
          const parsed = orderEngine.interface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "LoanOrderCreated") {
            orderId = parsed.args.orderId as bigint;
            break;
          }
        } catch {
          // ignore
        }
      }
      assertOk(orderId !== null, "LoanOrderCreated not found");
      return orderId as bigint;
    };

    const updatePrice = async (asset: string, ppm: bigint, label: string) => {
      const now = await latestBlockNumber();
      await waitTx(po.connect(deployer).updatePrice(asset, ppmToPrice(ppm), now), label);
    };

    const readRiskSample = async (borrowerAddr: string, asset: string) => {
      const [cachedHf, cachedValid, cachedBlock] = (await healthView.getUserHealthFactorWithMeta(borrowerAddr)) as [
        bigint,
        boolean,
        bigint,
      ];
      const liveCollateralUsd8 = (await positionView.getUserTotalCollateralValue(borrowerAddr)) as bigint;
      const liveDebtUsd8 = (await vle.getUserTotalDebtValue(borrowerAddr)) as bigint;
      const liveLiquidatable =
        liveDebtUsd8 > 0n
          ? ((await liquidationRiskManager.isLiquidatable(
              borrowerAddr,
              liveCollateralUsd8,
              liveDebtUsd8,
              asset
            )) as boolean)
          : false;
      return {
        borrowerAddr,
        asset,
        cachedHf,
        cachedValid,
        cachedBlock,
        liveCollateralUsd8,
        liveDebtUsd8,
        liveLiquidatable,
      };
    };

    const summarizeRiskSamples = (samples: Array<Awaited<ReturnType<typeof readRiskSample>>>) => {
      let minCachedHf: bigint | null = null;
      let anyLiveLiquidatable = false;
      const riskSamples: Array<Record<string, string | boolean>> = [];
      for (const sample of samples) {
        if (sample.cachedValid && (minCachedHf === null || sample.cachedHf < minCachedHf)) {
          minCachedHf = sample.cachedHf;
        }
        if (sample.liveLiquidatable) anyLiveLiquidatable = true;
        riskSamples.push({
          borrower: sample.borrowerAddr,
          asset: sample.asset,
          cachedHf: sample.cachedHf.toString(),
          cachedValid: sample.cachedValid,
          cachedBlock: sample.cachedBlock.toString(),
          liveCollateralUsd8: sample.liveCollateralUsd8.toString(),
          liveDebtUsd8: sample.liveDebtUsd8.toString(),
          liveLiquidatable: sample.liveLiquidatable,
        });
      }
      return { minCachedHf, anyLiveLiquidatable, riskSamples };
    };

    const settleAndAssert = async (orderId: bigint, borrowerAddr: string, asset: string) => {
      const debtBefore = (await vle.getDebt(borrowerAddr, asset)) as bigint;
      const colBefore = (await cm.getCollateral(borrowerAddr, asset)) as bigint;
      const penaltyDebtBefore = rewardAccrualManager
        ? ((await rewardAccrualManager.getPenaltyDebt(borrowerAddr)) as bigint)
        : null;

      const rewardBefore = rewardView ? ((await rewardView.getUserRewardSummaryWithMeta(borrowerAddr)) as any) : null;
      const easyBalBefore = easyToken ? ((await easyToken.balanceOf(borrowerAddr)) as bigint) : null;
      const easyBalViaViewBefore = rewardView
        ? (((await rewardView.getUserBalanceWithMeta(borrowerAddr)) as [bigint, bigint, boolean]) ?? null)
        : null;
      if (easyBalBefore !== null && easyBalViaViewBefore) {
        assertOk(easyBalViaViewBefore[0] === easyBalBefore, "RewardView.getUserBalanceWithMeta != EasyToken.balanceOf (before)");
      }

      const collateralAssets = (await cm.getUserCollateralAssets(borrowerAddr)) as string[];
      const collateralSnapshots: Array<{
        asset: string;
        balance: string;
        valueUsd8: string;
        priceBlock: string;
        priceValid: boolean;
        positionValueUsd8: string;
      }> = [];
      let bestBal = 0n;
      let bestAsset = "";
      for (const a of collateralAssets) {
        const bal = (await cm.getCollateral(borrowerAddr, a)) as bigint;
        let valueUsd8 = 0n;
        let priceBlock = 0n;
        let priceValid = false;
        let positionValueUsd8 = 0n;
        try {
          const [v, b, valid] = (await valuationOracleView.getAssetValueUsd8(a, bal)) as [bigint, bigint, boolean];
          valueUsd8 = v;
          priceBlock = b;
          priceValid = valid;
        } catch {
          valueUsd8 = 0n;
          priceBlock = 0n;
          priceValid = false;
        }
        try {
          positionValueUsd8 = (await positionView.getAssetValue(a, bal)) as bigint;
        } catch {
          positionValueUsd8 = 0n;
        }
        collateralSnapshots.push({
          asset: a,
          balance: bal.toString(),
          valueUsd8: valueUsd8.toString(),
          priceBlock: priceBlock.toString(),
          priceValid,
          positionValueUsd8: positionValueUsd8.toString(),
        });
        if (bal > bestBal) {
          bestBal = bal;
          bestAsset = a;
        }
      }

      // Ensure we are not proceeding with an unpriced collateral set.
      const anyPriced = collateralSnapshots.some((s) => s.priceValid && BigInt(s.priceBlock) > 0n);
      assertOk(anyPriced, "liquidation: no valid price snapshot (PriceOracle likely unseeded)");

      if (bestBal === 0n || !bestAsset) {
        return {
          skipped: true,
          reason: "no collateral",
          debtBefore,
          colBefore,
          penaltyDebtBefore,
          penaltyDebtAfter: penaltyDebtBefore,
          rewardPushes: [],
          pushes: [],
          collateralSnapshots,
        };
      }
      const colBeforeBest = (await cm.getCollateral(borrowerAddr, bestAsset)) as bigint;
      let liqRc: any;
      try {
        liqRc = await waitTx(settlementManager.connect(deployer).settleOrLiquidate(orderId), "settleOrLiquidate");
      } catch (e: any) {
        const msg = fmtErr(e);
        if (String(msg).includes("NoCollateral")) {
          const debtAmount = (await vle.getReducibleDebtAmount(borrowerAddr, asset)) as bigint;
          if (debtAmount === 0n) {
            return {
              skipped: true,
              reason: "no reducible debt",
              debtBefore,
              colBefore,
              penaltyDebtBefore,
              penaltyDebtAfter: penaltyDebtBefore,
              rewardPushes: [],
              pushes: [],
              collateralSnapshots,
            };
          }
          liqRc = await waitTx(
            liquidationManager
              .connect(deployer)
              .liquidate(borrowerAddr, bestAsset, asset, bestBal, debtAmount, 0),
            "liquidate fallback"
          );
          const pushes = extractDataPushed(liqRc, liquidatorViewAddr);
          const rewardPushes = !isZeroAddr(rewardViewAddr) ? extractDataPushed(liqRc, rewardViewAddr) : [];
          const wantUpdate = key("LIQUIDATION_UPDATE").toLowerCase();
          const wantPayout = key("LIQUIDATION_PAYOUT").toLowerCase();
          assertOk(
            pushes.some((p) => p.typeHash.toLowerCase() === wantUpdate || p.typeHash.toLowerCase() === wantPayout),
            "missing liquidation DataPushed(LIQUIDATION_*)"
          );
          const hasPenaltyLedger = rewardPushes.some(
            (p) => p.typeHash.toLowerCase() === key("REWARD_PENALTY_LEDGER_UPDATED").toLowerCase()
          );
          const hasRewardBurned = rewardPushes.some(
            (p) => p.typeHash.toLowerCase() === key("REWARD_BURNED").toLowerCase()
          );
          const debtAfter = (await vle.getDebt(borrowerAddr, asset)) as bigint;
          const colAfter = (await cm.getCollateral(borrowerAddr, bestAsset)) as bigint;
          const penaltyDebtAfter = rewardAccrualManager
            ? ((await rewardAccrualManager.getPenaltyDebt(borrowerAddr)) as bigint)
            : null;

          if (penaltyDebtBefore !== null && penaltyDebtAfter !== null) {
            if (penaltyDebtAfter !== penaltyDebtBefore) {
              assertOk(hasPenaltyLedger, "penaltyDebt changed but missing REWARD_PENALTY_LEDGER_UPDATED push");
            }
          }

          if (rewardView) {
            const rewardAfter = (await rewardView.getUserRewardSummaryWithMeta(borrowerAddr)) as any;
            const easyBalAfter = easyToken ? ((await easyToken.balanceOf(borrowerAddr)) as bigint) : null;
            const easyBalViaViewAfter = (await rewardView.getUserBalanceWithMeta(borrowerAddr)) as [bigint, bigint, boolean];
            if (easyBalAfter !== null) {
              assertOk(
                easyBalViaViewAfter[0] === easyBalAfter,
                "RewardView.getUserBalanceWithMeta != EasyToken.balanceOf (after)"
              );
            }

            if (rewardBefore) {
              const burnedBefore = BigInt(rewardBefore[0]);
              const pendingBefore = BigInt(rewardBefore[1]);
              const burnedAfter = BigInt(rewardAfter[0]);
              const pendingAfter = BigInt(rewardAfter[1]);
              assertOk(burnedAfter >= burnedBefore, "RewardView.totalBurned decreased (unexpected)");
              assertOk(pendingAfter >= 0n && pendingBefore >= 0n, "RewardView.pendingPenalty invariant failed");
              if (hasRewardBurned) {
                assertOk(burnedAfter > burnedBefore, "REWARD_BURNED pushed but totalBurned did not increase");
              }
              if (hasPenaltyLedger && penaltyDebtAfter !== null) {
                assertOk(
                  pendingAfter === penaltyDebtAfter,
                  "RewardView.pendingPenalty != RewardAccrualManager.penaltyDebt (after)"
                );
              }
            }
          }

          assertOk(debtAfter < debtBefore, "liquidation: debt did not decrease");
          assertOk(colAfter < bestBal, "liquidation: collateral did not decrease");
          return {
            debtBefore,
            debtAfter,
            colBefore: colBeforeBest,
            colAfter,
            penaltyDebtBefore,
            penaltyDebtAfter,
            rewardPushes: rewardPushes.map((p) => p.typeHash.toLowerCase()),
            pushes,
            fallback: true,
            collateralSnapshots,
            collateralAssetUsed: bestAsset,
          };
        }
        throw e;
      }
      const pushes = extractDataPushed(liqRc, liquidatorViewAddr);
      const rewardPushes = !isZeroAddr(rewardViewAddr) ? extractDataPushed(liqRc, rewardViewAddr) : [];
      const wantUpdate = key("LIQUIDATION_UPDATE").toLowerCase();
      const wantPayout = key("LIQUIDATION_PAYOUT").toLowerCase();
      assertOk(
        pushes.some((p) => p.typeHash.toLowerCase() === wantUpdate || p.typeHash.toLowerCase() === wantPayout),
        "missing liquidation DataPushed(LIQUIDATION_*)"
      );
      const hasPenaltyLedger = rewardPushes.some(
        (p) => p.typeHash.toLowerCase() === key("REWARD_PENALTY_LEDGER_UPDATED").toLowerCase()
      );
      const hasRewardBurned = rewardPushes.some(
        (p) => p.typeHash.toLowerCase() === key("REWARD_BURNED").toLowerCase()
      );

      const debtAfter = (await vle.getDebt(borrowerAddr, asset)) as bigint;
      const colAfter = (await cm.getCollateral(borrowerAddr, bestAsset)) as bigint;
      const penaltyDebtAfter = rewardAccrualManager
        ? ((await rewardAccrualManager.getPenaltyDebt(borrowerAddr)) as bigint)
        : null;

      if (STRICT_REWARD && !isZeroAddr(rewardViewAddr) && TRACK_GUARANTEE_PENALTY) {
        if (penaltyDebtBefore !== null && penaltyDebtAfter !== null && penaltyDebtAfter > penaltyDebtBefore) {
          assertOk(
            hasPenaltyLedger || hasRewardBurned,
            "liquidation/default changed reward state but missing RewardView.DataPushed(REWARD_PENALTY_LEDGER_UPDATED|REWARD_BURNED)"
          );
        }
      }

      // If penalty debt changed, RewardView must push penalty-ledger update in the same tx.
      if (penaltyDebtBefore !== null && penaltyDebtAfter !== null) {
        if (penaltyDebtAfter !== penaltyDebtBefore) {
          assertOk(hasPenaltyLedger, "penaltyDebt changed but missing REWARD_PENALTY_LEDGER_UPDATED push");
        }
      }

      // RewardView cache should be consistent with on-chain state after reward pushes.
      if (rewardView) {
        const rewardAfter = (await rewardView.getUserRewardSummaryWithMeta(borrowerAddr)) as any;
        const easyBalAfter = easyToken ? ((await easyToken.balanceOf(borrowerAddr)) as bigint) : null;
        const easyBalViaViewAfter = (await rewardView.getUserBalanceWithMeta(borrowerAddr)) as [bigint, bigint, boolean];
        if (easyBalAfter !== null) {
          assertOk(easyBalViaViewAfter[0] === easyBalAfter, "RewardView.getUserBalanceWithMeta != EasyToken.balanceOf (after)");
        }

        if (rewardBefore) {
          const burnedBefore = BigInt(rewardBefore[0]);
          const pendingBefore = BigInt(rewardBefore[1]);
          const burnedAfter = BigInt(rewardAfter[0]);
          const pendingAfter = BigInt(rewardAfter[1]);
          assertOk(burnedAfter >= burnedBefore, "RewardView.totalBurned decreased (unexpected)");
          assertOk(pendingAfter >= 0n && pendingBefore >= 0n, "RewardView.pendingPenalty invariant failed");
          if (hasRewardBurned) {
            assertOk(burnedAfter > burnedBefore, "REWARD_BURNED pushed but totalBurned did not increase");
          }
          if (hasPenaltyLedger && penaltyDebtAfter !== null) {
            assertOk(pendingAfter === penaltyDebtAfter, "RewardView.pendingPenalty != RewardAccrualManager.penaltyDebt (after)");
          }
        }
      }

      assertOk(debtAfter < debtBefore, "liquidation: debt did not decrease");
      assertOk(colAfter < colBeforeBest, "liquidation: collateral did not decrease");
      return {
        debtBefore,
        debtAfter,
        colBefore: colBeforeBest,
        colAfter,
        penaltyDebtBefore,
        penaltyDebtAfter,
        rewardPushes: rewardPushes.map((p) => p.typeHash.toLowerCase()),
        pushes,
        collateralSnapshots,
        collateralAssetUsed: bestAsset,
      };
    };

    const runGuaranteeFundsFlow = async () => {
      console.log("== Scenario: guarantee extension funds flow ==");
      const [earlyBorrower, earlyLender, defaultBorrower, defaultLender] = await makeWallets(4);
      const guaranteeUsers = [earlyBorrower.address, earlyLender.address, defaultBorrower.address, defaultLender.address];
      await ensureWhitelisted(guaranteeUsers, "stress guarantee extension flow");
      await fundUsers(usdc, guaranteeUsers, ethers.parseUnits("500000", 6), "fund guarantee users");
      await waitTx(ergm.connect(deployer).setGuaranteeEnabled(assetAddr, true), "enable guarantee flow");

      try {
        const earlyPrincipal = ethers.parseUnits("2500", 6);
        const earlyCollateral = ethers.parseUnits("8000", 6);
        const earlyTermDays = termDaysList[0] ?? 5;
        const earlyOrderId = await finalizeOne(
          "guarantee-early",
          assetAddr,
          assetAddr,
          earlyBorrower,
          earlyLender,
          earlyPrincipal,
          earlyCollateral,
          earlyTermDays
        );
        const earlyGuaranteeId = (await ergm.getUserGuaranteeId(earlyBorrower.address, assetAddr)) as bigint;
        assertOk(earlyGuaranteeId > 0n, "guarantee early: guaranteeId not created");
        assertOk(
          (await ergm.hasActiveGuarantee(earlyBorrower.address, assetAddr)) as boolean,
          "guarantee early: active guarantee missing after finalizeMatch"
        );
        const earlyLockedBefore = (await (await ethers.getContractAt(
          "src/Vault/modules/GuaranteeFundManager.sol:GuaranteeFundManager",
          guaranteeFundManagerAddr
        ) as any).getLockedGuarantee(earlyBorrower.address, assetAddr)) as bigint;
        assertOk(earlyLockedBefore > 0n, "guarantee early: custody balance not locked");

        const earlyDue = calcTotalDue(earlyPrincipal, rateBps, BigInt(earlyTermDays) * BLOCKS_PER_DAY);
        await waitTx(usdc.connect(earlyBorrower).approve(vaultCoreAddr, earlyDue), "approve guarantee early repay");
        const earlyRepayRc = await waitTx(
          vaultCore.connect(earlyBorrower).repay(earlyOrderId, assetAddr, earlyDue),
          "repay guarantee early"
        );
        let hasEarlyProcessed = false;
        for (const log of earlyRepayRc.logs ?? []) {
          try {
            const parsed = ergm.interface.parseLog({ topics: log.topics as string[], data: log.data });
            if (parsed?.name === "EarlyRepaymentProcessed") {
              hasEarlyProcessed = true;
              break;
            }
          } catch {
            // ignore
          }
        }
        assertOk(hasEarlyProcessed, "guarantee early: missing EarlyRepaymentProcessed event");
        const earlyLockedAfter = (await (await ethers.getContractAt(
          "src/Vault/modules/GuaranteeFundManager.sol:GuaranteeFundManager",
          guaranteeFundManagerAddr
        ) as any).getLockedGuarantee(earlyBorrower.address, assetAddr)) as bigint;
        assertOk(earlyLockedAfter === 0n, "guarantee early: custody balance not cleared after repay");
        assertOk(
          !((await ergm.hasActiveGuarantee(earlyBorrower.address, assetAddr)) as boolean),
          "guarantee early: active guarantee not cleared after repay"
        );

        const defaultPrincipal = ethers.parseUnits("2000", 6);
        const defaultCollateral = ethers.parseUnits("7000", 6);
        const defaultTermDays = termDaysList[0] ?? 5;
        const defaultOrderId = await finalizeOne(
          "guarantee-default",
          assetAddr,
          assetAddr,
          defaultBorrower,
          defaultLender,
          defaultPrincipal,
          defaultCollateral,
          defaultTermDays
        );
        const defaultGuaranteeId = (await ergm.getUserGuaranteeId(defaultBorrower.address, assetAddr)) as bigint;
        assertOk(defaultGuaranteeId > 0n, "guarantee default: guaranteeId not created");
        const defaultLockedBefore = (await (await ethers.getContractAt(
          "src/Vault/modules/GuaranteeFundManager.sol:GuaranteeFundManager",
          guaranteeFundManagerAddr
        ) as any).getLockedGuarantee(defaultBorrower.address, assetAddr)) as bigint;
        assertOk(defaultLockedBefore > 0n, "guarantee default: custody balance not locked");
        const defaultOrder = await orderEngine.getLoanOrderForView(defaultOrderId);
        await mineToBlock(BigInt(defaultOrder.maturity) + 1n);
        await updatePrice(assetAddr, PRICE_PPM, "refresh guarantee default price");
        const defaultLiqRc = await waitTx(
          settlementManager.connect(deployer).settleOrLiquidate(defaultOrderId),
          "settleOrLiquidate guarantee default"
        );
        let hasForfeited = false;
        for (const log of defaultLiqRc.logs ?? []) {
          try {
            const parsedErgm = ergm.interface.parseLog({ topics: log.topics as string[], data: log.data });
            if (parsedErgm?.name === "GuaranteeForfeited") {
              hasForfeited = true;
              break;
            }
          } catch {
            try {
              const gfm = (await ethers.getContractAt(
                "src/Vault/modules/GuaranteeFundManager.sol:GuaranteeFundManager",
                guaranteeFundManagerAddr
              )) as any;
              const parsedGfm = gfm.interface.parseLog({ topics: log.topics as string[], data: log.data });
              if (parsedGfm?.name === "GuaranteeForfeited") {
                hasForfeited = true;
                break;
              }
            } catch {
              // ignore
            }
          }
        }
        assertOk(hasForfeited, "guarantee default: missing GuaranteeForfeited event");
        const defaultLockedAfter = (await (await ethers.getContractAt(
          "src/Vault/modules/GuaranteeFundManager.sol:GuaranteeFundManager",
          guaranteeFundManagerAddr
        ) as any).getLockedGuarantee(defaultBorrower.address, assetAddr)) as bigint;
        assertOk(defaultLockedAfter === 0n, "guarantee default: custody balance not cleared after settleOrLiquidate");
        assertOk(
          !((await ergm.hasActiveGuarantee(defaultBorrower.address, assetAddr)) as boolean),
          "guarantee default: active guarantee not cleared after settleOrLiquidate"
        );

        data.scenarios.push({
          label: "guarantee-extension-flow",
          earlyRepay: {
            borrower: earlyBorrower.address,
            lender: earlyLender.address,
            orderId: earlyOrderId.toString(),
            guaranteeId: earlyGuaranteeId.toString(),
            lockedBefore: earlyLockedBefore.toString(),
            lockedAfter: earlyLockedAfter.toString(),
          },
          defaultFlow: {
            borrower: defaultBorrower.address,
            lender: defaultLender.address,
            orderId: defaultOrderId.toString(),
            guaranteeId: defaultGuaranteeId.toString(),
            lockedBefore: defaultLockedBefore.toString(),
            lockedAfter: defaultLockedAfter.toString(),
          },
        });
      } finally {
        await waitTx(ergm.connect(deployer).setGuaranteeEnabled(assetAddr, false), "disable guarantee flow");
      }
    };

    const runMultiAssetCrash = async () => {
      console.log("== Scenario: multi-asset crash + liquidation ==");
      const orders: Array<any> = [];
      const activePairs = new Set<string>();

      const multiBorrowerPool = borrowerList.slice(0, clampMultiOrders);
      for (let orderIdx = 0; orderIdx < clampMultiOrders; orderIdx++) {
        const asset = assets[orderIdx % assets.length];
        const l = pickSigner(lenderList, orderIdx, fallbacks.lender);
        const chosenBorrower = multiBorrowerPool[orderIdx];
        if (!chosenBorrower) break;
        const keyPair = `${chosenBorrower.address.toLowerCase()}:${asset.toLowerCase()}`;
        if (activePairs.has(keyPair)) continue;
        activePairs.add(keyPair);
        const cycle = orderIdx % leverageCycles;
        const baseUsd = seededValue(orderIdx + 11, usdMin, usdMax);
        const principalUsd = rollPrincipal(baseUsd, cycle, rollRatio);
        const decimals = decimalsByAsset.get(asset) ?? 6;
        const principalAmt = ethers.parseUnits(principalUsd.toString(), decimals);
        const collateralAsset = COLLATERAL_ASSET_MODE === "settlement" ? assetAddr : asset;
        const collateralDecimals = decimalsByAsset.get(collateralAsset) ?? 6;
        const collateralUsd = scaleByPpm(principalUsd, collateralRatio);
        const collateralAmtAdj =
          collateralAsset.toLowerCase() === asset.toLowerCase()
            ? scaleByPpm(principalAmt, collateralRatio)
            : ethers.parseUnits(collateralUsd.toString(), collateralDecimals);
        const termDays = termDaysList[cycle % termDaysList.length];

        const orderId = await finalizeOne(
          `multi-${orderIdx}-c${cycle}`,
          asset,
          collateralAsset,
          chosenBorrower,
          l,
          principalAmt,
          collateralAmtAdj,
          termDays
        );
        const ord = await orderEngine.getLoanOrderForView(orderId);
        orders.push({
          orderId,
          borrowerAddr: chosenBorrower.address,
          asset,
          maturity: BigInt(ord.maturity),
          baseUsd,
          principalUsd: principalUsd.toString(),
          termDays,
          cycle,
        });
      }

      const pricePath: Record<string, string[]> = {};
      for (let i = 0; i < assets.length; i++) {
        pricePath[assets[i]] = [];
      }

      for (let i = 0; i < assets.length; i++) {
        const asset = assets[i];
        const shock = i === 0 ? MULTI_SHOCK_A_PPM : MULTI_SHOCK_B_PPM;
        await updatePrice(asset, shock, `price shock asset${i + 1}`);
        pricePath[asset].push(shock.toString());
        if (i > 0) {
          for (let lag = 0; lag < MULTI_LAG_ROUNDS * i; lag++) {
            await mineToBlock((await latestBlockNumber()) + 1n);
          }
        }
      }

      for (let i = 0; i < MULTI_OSCILLATIONS; i++) {
        const isRebound = i % 2 === 0;
        for (let a = 0; a < assets.length; a++) {
          const asset = assets[a];
          const rebound = a % 2 === 0 ? MULTI_REBOUND_A_PPM : MULTI_REBOUND_B_PPM;
          const shock = a % 2 === 0 ? MULTI_SHOCK_A_PPM : MULTI_SHOCK_B_PPM;
          const target = isRebound ? rebound : shock;
          await updatePrice(asset, target, `oscillation asset${a + 1} ${i + 1}`);
          pricePath[asset].push(target.toString());
        }
      }

      for (let a = 0; a < assets.length; a++) {
        const asset = assets[a];
        const crash = a % 2 === 0 ? MULTI_CRASH_A_PPM : MULTI_CRASH_B_PPM;
        await updatePrice(asset, crash, `final crash asset${a + 1}`);
        pricePath[asset].push(crash.toString());
      }

      const liqThreshold = (await liquidationRiskManager.getLiquidationThreshold()) as bigint;
      let deepenedCrashRounds = 0;
      let rawRiskSamples = await Promise.all(orders.map((ord) => readRiskSample(ord.borrowerAddr, ord.asset)));
      let { minCachedHf, anyLiveLiquidatable, riskSamples } = summarizeRiskSamples(rawRiskSamples);

      while (!anyLiveLiquidatable && !(minCachedHf !== null && minCachedHf < liqThreshold) && deepenedCrashRounds < 4) {
        deepenedCrashRounds += 1;
        const targets = COLLATERAL_ASSET_MODE === "settlement" ? [assetAddr] : assets;
        for (const targetAsset of targets) {
          const path = pricePath[targetAsset] ?? [];
          const current = path.length ? BigInt(path[path.length - 1]) : PRICE_PPM;
          const next = current > 1n ? current / 2n : 1n;
          await updatePrice(targetAsset, next, `deepen crash ${deepenedCrashRounds} ${targetAsset}`);
          path.push(next.toString());
          pricePath[targetAsset] = path;
        }
        rawRiskSamples = await Promise.all(orders.map((ord) => readRiskSample(ord.borrowerAddr, ord.asset)));
        ({ minCachedHf, anyLiveLiquidatable, riskSamples } = summarizeRiskSamples(rawRiskSamples));
      }

      assertOk(
        anyLiveLiquidatable || (minCachedHf !== null && minCachedHf < liqThreshold),
        "no borrower below liquidation threshold after multi-asset crash"
      );

      const maxMaturity = orders.reduce((acc, o) => (o.maturity > acc ? o.maturity : acc), 0n);
      await mineToBlock(maxMaturity + 1n);
      for (const asset of assets) {
        const path = pricePath[asset] ?? [];
        const last = path.length ? BigInt(path[path.length - 1]) : PRICE_PPM;
        await updatePrice(asset, last, `refresh price ${asset}`);
      }

      const liquidationResults = [] as Array<any>;
      for (const ord of orders) {
        const res = await settleAndAssert(ord.orderId, ord.borrowerAddr, ord.asset);
        liquidationResults.push({
          orderId: ord.orderId.toString(),
          asset: ord.asset,
          borrower: ord.borrowerAddr,
          termDays: ord.termDays,
          cycle: ord.cycle,
          baseUsd: ord.baseUsd,
          principalUsd: ord.principalUsd,
          skipped: res.skipped ?? false,
          reason: res.reason ?? "",
          fallbackLiquidation: res.fallback ?? false,
          collateralSnapshots: res.collateralSnapshots ?? [],
          collateralAssetUsed: res.collateralAssetUsed ?? "",
          debtBefore: res.debtBefore?.toString?.() ?? "0",
          debtAfter: res.debtAfter?.toString?.() ?? "0",
          collateralBefore: res.colBefore?.toString?.() ?? "0",
          collateralAfter: res.colAfter?.toString?.() ?? "0",
          penaltyDebtBefore: res.penaltyDebtBefore?.toString?.() ?? "",
          penaltyDebtAfter: res.penaltyDebtAfter?.toString?.() ?? "",
          rewardPushes: res.rewardPushes ?? [],
          liquidationPushes: (res.pushes ?? []).map((p: any) => p.typeHash.toLowerCase()),
        });
      }

      data.scenarios.push({
        label: "multi-asset-crash",
        orders: liquidationResults,
        pricePath,
        liquidationThreshold: liqThreshold.toString(),
        deepenedCrashRounds,
        riskSamples,
      });
    };

    const runLongRunGrind = async () => {
      console.log("== Scenario: long-run grind ==");
      const orders: Array<any> = [];
      const activePairs = new Set<string>();
      const grindBorrowerPool = borrowerList.slice(clampMultiOrders, clampMultiOrders + clampGrindOrders);
      for (let orderIdx = 0; orderIdx < clampGrindOrders; orderIdx++) {
        const asset = assets[orderIdx % assets.length];
        const l = pickSigner(lenderList, orderIdx + 33, fallbacks.lender);
        const chosenBorrower = grindBorrowerPool[orderIdx];
        if (!chosenBorrower) break;
        const keyPair = `${chosenBorrower.address.toLowerCase()}:${asset.toLowerCase()}`;
        if (activePairs.has(keyPair)) continue;
        activePairs.add(keyPair);
        const cycle = orderIdx % leverageCycles;
        const baseUsd = seededValue(orderIdx + 101, usdMin, usdMax);
        const principalUsd = rollPrincipal(baseUsd, cycle, rollRatio);
        const decimals = decimalsByAsset.get(asset) ?? 6;
        const principalAmt = ethers.parseUnits(principalUsd.toString(), decimals);
        const collateralAsset = COLLATERAL_ASSET_MODE === "settlement" ? assetAddr : asset;
        const collateralDecimals = decimalsByAsset.get(collateralAsset) ?? 6;
        const collateralUsd = scaleByPpm(principalUsd, collateralRatio);
        const collateralAmtAdj =
          collateralAsset.toLowerCase() === asset.toLowerCase()
            ? scaleByPpm(principalAmt, collateralRatio)
            : ethers.parseUnits(collateralUsd.toString(), collateralDecimals);
        const termDays = termDaysList[cycle % termDaysList.length];
        const orderId = await finalizeOne(
          `grind-${orderIdx}-c${cycle}`,
          asset,
          collateralAsset,
          chosenBorrower,
          l,
          principalAmt,
          collateralAmtAdj,
          termDays
        );
        const ord = await orderEngine.getLoanOrderForView(orderId);
        orders.push({
          orderId,
          borrowerAddr: chosenBorrower.address,
          asset,
          maturity: BigInt(ord.maturity),
          baseUsd,
          principalUsd: principalUsd.toString(),
          termDays,
          cycle,
        });
      }

      const priceByAsset = new Map<string, bigint>();
      for (const asset of assets) priceByAsset.set(asset, PRICE_PPM);

      for (let r = 0; r < GRIND_ROUNDS; r++) {
        for (let a = 0; a < assets.length; a++) {
          const asset = assets[a];
          const current = priceByAsset.get(asset) ?? PRICE_PPM;
          const step = GRIND_STEP_PPM + BigInt(a) * (GRIND_STEP_PPM / 4n);
          let next = current > step ? current - step : 1n;
          if ((r + 1) % GRIND_REBOUND_EVERY === 0) {
            next = next + GRIND_REBOUND_PPM;
          }
          priceByAsset.set(asset, next);
          await updatePrice(asset, next, `grind round ${r + 1} asset${a + 1}`);
        }
      }

      const maxMaturity = orders.reduce((acc, o) => (o.maturity > acc ? o.maturity : acc), 0n);
      await mineToBlock(maxMaturity + 1n);
      for (const asset of assets) {
        const last = priceByAsset.get(asset) ?? PRICE_PPM;
        await updatePrice(asset, last, `refresh price ${asset}`);
      }

      const liquidationResults = [] as Array<any>;
      for (const ord of orders) {
        const res = await settleAndAssert(ord.orderId, ord.borrowerAddr, ord.asset);
        liquidationResults.push({
          orderId: ord.orderId.toString(),
          asset: ord.asset,
          borrower: ord.borrowerAddr,
          termDays: ord.termDays,
          cycle: ord.cycle,
          baseUsd: ord.baseUsd,
          principalUsd: ord.principalUsd,
          skipped: res.skipped ?? false,
          reason: res.reason ?? "",
          fallbackLiquidation: res.fallback ?? false,
          collateralSnapshots: res.collateralSnapshots ?? [],
          collateralAssetUsed: res.collateralAssetUsed ?? "",
          debtBefore: res.debtBefore?.toString?.() ?? "0",
          debtAfter: res.debtAfter?.toString?.() ?? "0",
          collateralBefore: res.colBefore?.toString?.() ?? "0",
          collateralAfter: res.colAfter?.toString?.() ?? "0",
          penaltyDebtBefore: res.penaltyDebtBefore?.toString?.() ?? "",
          penaltyDebtAfter: res.penaltyDebtAfter?.toString?.() ?? "",
          rewardPushes: res.rewardPushes ?? [],
          liquidationPushes: (res.pushes ?? []).map((p: any) => p.typeHash.toLowerCase()),
        });
      }

      data.scenarios.push({
        label: "long-run-grind",
        orders: liquidationResults,
        grind: {
          rounds: GRIND_ROUNDS,
          stepPpm: GRIND_STEP_PPM.toString(),
          reboundEvery: GRIND_REBOUND_EVERY,
          reboundPpm: GRIND_REBOUND_PPM.toString(),
        },
      });
    };
    data.config = {
      mode: STRESS_MODE,
      assetCount,
      leverageCycles,
      rollRatioPpm: rollRatio.toString(),
      termDays: termDaysList,
      positionUsdMin: usdMin,
      positionUsdMax: usdMax,
      collateralRatioPpm: collateralRatio.toString(),
      collateralAssetMode: COLLATERAL_ASSET_MODE,
      multiOrders: clampMultiOrders,
      grindOrders: clampGrindOrders,
      guaranteeExtensionFlowEnabled: ENABLE_GUARANTEE_EXTENSION_FLOW,
      assets,
      reward: {
        strictReward: STRICT_REWARD,
        trackGuaranteePenalty: TRACK_GUARANTEE_PENALTY,
        rewardViewAddr: !isZeroAddr(rewardViewAddr) ? rewardViewAddr : "",
        rewardAccrualManagerAddr: !isZeroAddr(rewardAccrualManagerAddr) ? rewardAccrualManagerAddr : "",
        easyEmissionConfigAddr: !isZeroAddr(easyEmissionConfigAddr) ? easyEmissionConfigAddr : "",
        rewardManagerCoreAddr,
      },
    };

    data.rewardExtendedChecks = await runRewardExtendedChecks({
      registry,
      acm,
      deployer,
      waitTx,
      strictReward: STRICT_REWARD,
      rewardView,
      rewardViewAddr,
      easyEmissionConfig,
      easyEmissionConfigAddr,
      rewardAccrualManager,
      ramAddr: rewardAccrualManagerAddr,
      rmCoreAddr: rewardManagerCoreAddr,
      artifactTarget: data,
      artifactKey: "rewardExtendedChecks",
      log: console.log,
      logNotice: console.log,
    });

    if (ENABLE_GUARANTEE_EXTENSION_FLOW) {
      await runGuaranteeFundsFlow();
    }

    if (STRESS_MODE === "multi" || STRESS_MODE === "multi+grind") {
      await runMultiAssetCrash();
    }
    if (STRESS_MODE === "grind" || STRESS_MODE === "multi+grind") {
      await runLongRunGrind();
    }

    const out = artifacts.writeJson(`price-liquidation-stress.${Date.now()}.json`, data);
    const latestReport = buildStressLatestReport(data, out);
    const latestReportPath = artifacts.writeDocJson("Stress-Report-Latest.json", latestReport);
    console.log(`\nArtifacts: ${out}`);
    console.log(`Summary: ${latestReportPath}`);
    console.log("\n✅ Price/Liquidation Stress finished.");
  } catch (e: any) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await network.provider.send("evm_revert", [snap]);
  }
}

main();
