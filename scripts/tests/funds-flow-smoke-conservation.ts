import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";
import {
  assertConservation,
  discoverTrackedAddresses,
  getErc20,
  snapshotBalances as snapshotBalancesShared,
  fmtAmount as fmtAmountShared,
} from "./_fundsFlowUtils";

// This smoke test focuses on "funds conservation" invariants for ERC20 tokens:
// - totalSupply does not change across actions (no mint/burn)
// - the sum of balances across an explicitly tracked address set is conserved
//
// It is *not* a full system proof: conservation is checked relative to the tracked set.
// If tokens flow to an untracked address, the test will fail and print the diff.

const ONE_DAY = 24n * 60n * 60n;
let cachedNonStableCollateral: string | null = null;

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function uniqAddrs(addrs: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of addrs) {
    if (!a || a === ethers.ZeroAddress) continue;
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

async function getErc20Meta(tokenAddr: string) {
  const erc20 = await getErc20(tokenAddr);
  const [symbol, decimals] = await Promise.all([erc20.symbol().catch(() => "TOKEN"), erc20.decimals().catch(() => 18)]);
  return { erc20, symbol: String(symbol), decimals: Number(decimals) };
}

async function getOrDeployNonStableCollateral(deployer: any) {
  if (cachedNonStableCollateral) return cachedNonStableCollateral;
  const mockErc20Factory = await ethers.getContractFactory("MockERC20");
  // NOTE: constructor mints initialSupply to deployer (single-time mint at deployment); no further minting is used in flows.
  const mock = await mockErc20Factory.deploy("MockWETH", "mWETH", ethers.parseUnits("1000000", 18));
  await mock.waitForDeployment();
  cachedNonStableCollateral = mock.target as string;
  console.log(`  ℹ️  Deployed non-stable collateral token mWETH @ ${cachedNonStableCollateral}`);
  return cachedNonStableCollateral;
}

async function filterDeployedContracts(addrs: string[]) {
  const uniq = uniqAddrs(addrs);
  const codes = await Promise.all(
    uniq.map(async (a) => {
      try {
        return [a, await ethers.provider.getCode(a)] as const;
      } catch {
        return [a, "0x"] as const;
      }
    })
  );
  return codes.filter(([, code]) => code && code !== "0x").map(([a]) => a);
}

async function getTokenUniverse(opts: {
  assetWhitelistAddr: string;
  priceOracleAddr: string;
  feeRouterAddr: string;
  extra?: string[];
}) {
  const extra = opts.extra ?? [];

  // Best-effort: any read failure should not block the smoke test.
  let awTokens: string[] = [];
  let oracleTokens: string[] = [];
  let feeRouterTokens: string[] = [];

  try {
    const aw = (await ethers.getContractAt("AssetWhitelist", opts.assetWhitelistAddr)) as any;
    awTokens = (await aw.getAllowedAssets()) as string[];
  } catch {
    // skip
  }
  try {
    const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", opts.priceOracleAddr)) as any;
    oracleTokens = (await po.getSupportedAssets()) as string[];
  } catch {
    // skip
  }
  try {
    const fr = (await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", opts.feeRouterAddr)) as any;
    feeRouterTokens = (await fr.getSupportedTokens()) as string[];
  } catch {
    // skip
  }

  // Keep only deployed contracts to avoid snapshotting random placeholder addresses.
  return await filterDeployedContracts([...extra, ...awTokens, ...oracleTokens, ...feeRouterTokens]);
}

async function snapshotBalancesMany(tokens: string[], addresses: string[]) {
  const out = new Map<string, Awaited<ReturnType<typeof snapshotBalancesShared>>>();
  for (const t of uniqAddrs(tokens)) {
    try {
      const snap = await snapshotBalancesShared(t, addresses);
      out.set(t.toLowerCase(), snap);
    } catch (e) {
      console.log(`  ⚠️  snapshot skipped for ${shortAddr(t)} (not ERC20 / read failed):`, e);
    }
  }
  return out;
}

function assertConservationMany(label: string, before: Map<string, any>, after: Map<string, any>) {
  const keys = uniqAddrs([...before.keys(), ...after.keys()]);
  for (const k of keys) {
    const b = before.get(k.toLowerCase());
    const a = after.get(k.toLowerCase());
    if (!b || !a) continue;
    assertConservation(`${label}:${b.symbol}`, b, a);
  }
}

function calcFeeBps(amount: bigint, feeBps: bigint) {
  return (amount * feeBps) / 10_000n;
}

function tryExtractRevertSelector(e: any): string | null {
  // Best-effort extraction of the 4-byte selector from various Hardhat/Ethers error shapes.
  // We specifically want to handle cases like:
  //   "reverted with an unrecognized custom error (return data: 0x66e24701)"
  // where the message does not include the custom error name.
  try {
    const msg = String(e?.message ?? e);
    const m = msg.match(/return data:\s*(0x[0-9a-fA-F]{8})/);
    if (m?.[1]) return m[1].toLowerCase();
  } catch {
    // ignore
  }
  // Some providers stick revert data on `data`/`error.data` fields.
  const candidates = [e?.data, e?.error?.data, e?.info?.error?.data, e?.receipt?.revertReason];
  for (const c of candidates) {
    if (!c) continue;
    const s = String(c);
    if (s.startsWith("0x") && s.length >= 10) return s.slice(0, 10).toLowerCase();
  }
  return null;
}

function buildExpectedRevertMatchers(hints: string[] | undefined): { needles: string[]; selectors: string[] } {
  const needles = (hints ?? []).filter(Boolean);
  const selectors: string[] = [];
  for (const h of needles) {
    const trimmed = String(h).trim();
    if (!trimmed) continue;
    // Allow passing the selector directly: e.g. "0x66e24701"
    if (/^0x[0-9a-fA-F]{8}$/.test(trimmed)) {
      selectors.push(trimmed.toLowerCase());
      continue;
    }
    // Allow passing error name or full signature; normalize to signature and derive selector.
    // README uses e.g. "SettlementManager__NoCollateral" (without parentheses).
    const sig = trimmed.includes("(") ? trimmed : `${trimmed}()`;
    try {
      selectors.push(ethers.id(sig).slice(0, 10).toLowerCase());
    } catch {
      // ignore (not a valid signature string)
    }
  }
  return { needles, selectors: Array.from(new Set(selectors)) };
}

async function mustRevert(label: string, p: Promise<any>, hints?: string[]) {
  try {
    await p;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (hints?.length) {
      const { needles, selectors } = buildExpectedRevertMatchers(hints);
      const actualSelector = tryExtractRevertSelector(e);

      const okByMsg = needles.some((h) => msg.includes(h));
      const okBySelector = !!actualSelector && selectors.some((s) => s === actualSelector);

      if (!okByMsg && !okBySelector) {
        console.log(
          `  ⚠️  ${label} reverted, but did not match EXPECT hints.\n` +
            `     hints=${JSON.stringify(needles)} selectors=${JSON.stringify(selectors)}\n` +
            `     actualSelector=${actualSelector ?? "<none>"}\n` +
            `     msg=${msg}`
        );
      }
    }
    return;
  }
  throw new Error(`[${label}] expected revert, but call succeeded`);
}

// Use shared snapshot/assert helpers from _fundsFlowUtils to avoid drifting behavior across scripts.

async function getOrderForView(orderEngineAddr: string, orderId: bigint) {
  const orderEngineView = await ethers.getContractAt(
    [
      "function _getLoanOrderForView(uint256) view returns (tuple(uint256 principal,uint256 rate,uint256 term,address borrower,address lender,address asset,uint256 startTimestamp,uint256 maturity,uint256 repaidAmount))",
    ],
    orderEngineAddr
  );
  return (await orderEngineView._getLoanOrderForView(orderId)) as {
    principal: bigint;
    rate: bigint;
    term: bigint;
    borrower: string;
    lender: string;
    asset: string;
    startTimestamp: bigint;
    maturity: bigint;
    repaidAmount: bigint;
  };
}

function calcInterest(principal: bigint, rateBps: bigint, termSec: bigint) {
  // Simple interest: principal * rateBps/1e4 * termSec / 365d
  const YEAR = 365n * ONE_DAY;
  return (principal * rateBps * termSec) / (10_000n * YEAR);
}

async function createOrder(opts: {
  makeOverdue: boolean;
  borrowerSigner: any;
  lenderSigner: any;
  keeperSigner: any;
}): Promise<{ orderId: bigint; borrower: string; keeper: string }> {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const keeper = opts.keeperSigner;
  const borrower = opts.borrowerSigner;
  const lender = opts.lenderSigner;
  if (keeper.address.toLowerCase() === borrower.address.toLowerCase()) {
    throw new Error("[Config] keeper must differ from borrower for liquidation tests.");
  }
  const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
  const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;
  const aw = (await ethers.getContractAt("AssetWhitelist", CONTRACT_ADDRESSES.AssetWhitelist)) as any;
  const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", CONTRACT_ADDRESSES.PriceOracle)) as any;
  // IMPORTANT: use the FeeRouter resolved from Registry (SSOT). finalizeMatch -> SettlementMatchLib resolves FeeRouter via Registry.
  const feeRouterAddr = (await registry.getModuleOrRevert(key("FEE_ROUTER"))) as string;
  const feeRouter = (await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", feeRouterAddr)) as any;
  const usdc = (await ethers.getContractAt("MockERC20", CONTRACT_ADDRESSES.MockUSDC)) as any;

  const vaultCoreAddr = (await registry.getModuleOrRevert(key("VAULT_CORE"))) as string;
  const vblAddr = (await registry.getModuleOrRevert(key("VAULT_BUSINESS_LOGIC"))) as string;
  const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;
  const collateralManagerAddr = (await registry.getModuleOrRevert(key("COLLATERAL_MANAGER"))) as string;
  const loanNftAddr = (await registry.getModuleOrRevert(key("LOAN_NFT"))) as string;
  // Extension Flow modules (best-effort; older deployments may not have them)
  const gfmAddr = (await registry.getModule(key("GUARANTEE_FUND_MANAGER"))) as string;
  const ergmAddr = (await registry.getModule(key("EARLY_REPAYMENT_GUARANTEE_MANAGER"))) as string;

  const vaultCore = (await ethers.getContractAt("VaultCore", vaultCoreAddr)) as any;
  const vbl = (await ethers.getContractAt("VaultBusinessLogic", vblAddr)) as any;
  const orderEngine = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", orderEngineAddr)) as any;
  const loanNft = await ethers.getContractAt("LoanNFT", loanNftAddr);

  const ACTION_ADD_WHITELIST = key("ADD_WHITELIST");
  const ACTION_UPDATE_PRICE = key("UPDATE_PRICE");
  const ACTION_SET_PARAMETER = key("SET_PARAMETER");
  const ACTION_DEPOSIT = key("DEPOSIT");
  const ACTION_ORDER_CREATE = key("ORDER_CREATE");
  const ACTION_BORROW = key("BORROW");

  const ensureRole = async (role: string, who: string) => {
    if (!(await acm.hasRole(role, who))) await acm.grantRole(role, who);
  };

  await ensureRole(ACTION_ADD_WHITELIST, deployer.address);
  await ensureRole(ACTION_UPDATE_PRICE, deployer.address);
  await ensureRole(ACTION_SET_PARAMETER, deployer.address);
  await ensureRole(ACTION_ORDER_CREATE, vblAddr);
  await ensureRole(ACTION_DEPOSIT, vblAddr);
  await ensureRole(ACTION_BORROW, orderEngineAddr);

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
  await po.connect(deployer).updatePrice(usdc.target, ethers.parseUnits("1", 8), now);
  if (!(await feeRouter.isTokenSupported(usdc.target))) {
    await feeRouter.connect(deployer).addSupportedToken(usdc.target);
  }

  // Fund test signers (moves funds from deployer -> users; does not change totalSupply).
  await usdc.connect(deployer).transfer(borrower.address, ethers.parseUnits("20000", 6));
  await usdc.connect(deployer).transfer(lender.address, ethers.parseUnits("20000", 6));
  await usdc.connect(deployer).transfer(keeper.address, ethers.parseUnits("20000", 6));

  // ===== (B) Full-chain non-stable collateral option =====
  const useNonStableCollateral = process.env.USE_NONSTABLE_COLLATERAL === "1";
  const collateralPriceMode = (process.env.COLLATERAL_PRICE_MODE ?? "fresh").toLowerCase(); // fresh|stale|unreasonable|bad_decimals

  let collateralAssetAddr = usdc.target as string;
  let collateralAmt = ethers.parseUnits("1000", 6);
  if (useNonStableCollateral) {
    collateralAssetAddr = await getOrDeployNonStableCollateral(deployer);
    collateralAmt = ethers.parseUnits("1", 18); // 1 mWETH

    if (!(await aw.isAssetAllowed(collateralAssetAddr))) {
      await aw.connect(deployer).addAllowedAsset(collateralAssetAddr);
    }

    // Configure/update collateral oracle based on mode
    const now2 = (await ethers.provider.getBlock("latest"))!.timestamp;
    if (collateralPriceMode === "stale") {
      await po.connect(deployer).configureAsset(collateralAssetAddr, "mock-weth", 8, 1);
      await po.connect(deployer).updatePrice(collateralAssetAddr, ethers.parseUnits("2000", 8), now2 - 10);
    } else if (collateralPriceMode === "unreasonable") {
      await po.connect(deployer).configureAsset(collateralAssetAddr, "mock-weth", 8, 3600);
      await po.connect(deployer).updatePrice(collateralAssetAddr, 10n ** 13n, now2); // > 1e12 => unreasonable (GD path), PV will return 0 if getPrice reverts
    } else if (collateralPriceMode === "bad_decimals") {
      await po.connect(deployer).configureAsset(collateralAssetAddr, "mock-weth", 4, 3600); // <6 triggers GD fallback in valuation paths that use GD
      await po.connect(deployer).updatePrice(collateralAssetAddr, ethers.parseUnits("2000", 4), now2);
    } else {
      await po.connect(deployer).configureAsset(collateralAssetAddr, "mock-weth", 8, 3600);
      await po.connect(deployer).updatePrice(collateralAssetAddr, ethers.parseUnits("2000", 8), now2);
    }

    // Fund borrower with collateral token from deployer (moves funds only; totalSupply unchanged across actions)
    const colToken = (await ethers.getContractAt("MockERC20", collateralAssetAddr)) as any;
    await colToken.connect(deployer).transfer(borrower.address, collateralAmt);
    await colToken.connect(borrower).approve(collateralManagerAddr, collateralAmt);
    await vaultCore.connect(borrower).deposit(collateralAssetAddr, collateralAmt);
  } else {
    await usdc.connect(borrower).approve(collateralManagerAddr, collateralAmt);
    await vaultCore.connect(borrower).deposit(usdc.target, collateralAmt);
  }

  const borrowAmt = ethers.parseUnits("500", 6);
  const termDays = 5;
  const rateBps = 1000n;
  const expireAt = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);

  const borrowIntent = {
    borrower: borrower.address,
    collateralAsset: collateralAssetAddr,
    collateralAmount: collateralAmt,
    borrowAsset: usdc.target,
    amount: borrowAmt,
    termDays,
    rateBps,
    expireAt,
    salt: ethers.keccak256(ethers.toUtf8Bytes(`smoke-borrow-salt-${Date.now()}`)),
  };

  const lendIntent = {
    lenderSigner: lender.address,
    asset: usdc.target,
    amount: borrowAmt,
    minTermDays: 1,
    maxTermDays: 30,
    minRateBps: 0n,
    expireAt,
    salt: ethers.keccak256(ethers.toUtf8Bytes(`smoke-lend-salt-${Date.now()}`)),
  };

  // Lender reserve (moves lender funds into LenderPoolVault).
  await usdc.connect(lender).approve(vblAddr, borrowAmt);
  const typeHash = ethers.keccak256(
    ethers.toUtf8Bytes(
      "LendIntent(address lenderSigner,address asset,uint256 amount,uint16 minTermDays,uint16 maxTermDays,uint256 minRateBps,uint256 expireAt,bytes32 salt)"
    )
  );
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const lendHash = ethers.keccak256(
    coder.encode(
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
      ]
    )
  );
  await vbl.connect(lender).reserveForLending(lender.address, usdc.target, borrowAmt, lendHash);

  // Typed-data signatures for finalizeMatch.
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

  // Extension Flow: if guarantee is enabled for borrow asset, borrower must approve GFM for promisedInterest
  // before finalizeMatch (VBL will pull it via GFM.lockGuarantee).
  if (ergmAddr && ergmAddr !== ethers.ZeroAddress && gfmAddr && gfmAddr !== ethers.ZeroAddress) {
    try {
      const ergm = await ethers.getContractAt(["function isGuaranteeEnabled(address) view returns (bool)"], ergmAddr);
      const enabled = (await ergm.isGuaranteeEnabled(usdc.target)) as boolean;
      if (enabled) {
        const termSec = BigInt(termDays) * ONE_DAY;
        const promisedInterest = calcInterest(borrowAmt, rateBps, termSec);
        if (promisedInterest > 0n) {
          await usdc.connect(borrower).approve(gfmAddr, promisedInterest);
        }
      }
    } catch (e) {
      console.log("  ⚠️  ExtensionFlow pre-approve skipped (could not read ERGM/isGuaranteeEnabled):", e);
    }
  }

  // ===== (C) Fee distribution: assert exact destination + proportion =====
  // SettlementMatchLib.finalizeAtomicFull uses FeeRouter.distributeNormal(borrowAsset, amount) where amount == borrowAmt.
  // So expected: platformTreasury += borrowAmt * platformFeeBps/1e4, ecosystemVault += borrowAmt * ecoFeeBps/1e4.
  const assertFeesOnCreate = process.env.ASSERT_FEES_ON_CREATE !== "0";
  const feeTypeNormal = key("DEPOSIT"); // FeeRouter.distributeNormal uses ActionKeys.ACTION_DEPOSIT internally
  const [platformFeeBps, ecoFeeBps, platformTreasury, ecosystemVault] = (await Promise.all([
    feeRouter.getPlatformFeeBps(),
    feeRouter.getEcosystemFeeBps(),
    feeRouter.getPlatformTreasury(),
    feeRouter.getEcosystemVault(),
  ])) as [bigint, bigint, string, string];
  const platformBefore = (await usdc.balanceOf(platformTreasury)) as bigint;
  const ecoBefore = (await usdc.balanceOf(ecosystemVault)) as bigint;
  const [opsBefore, statsBefore] = (await Promise.all([
    feeRouter.getOperationStats().catch(() => [0n, 0n] as const),
    feeRouter.getFeeStatistics(usdc.target, feeTypeNormal).catch(() => 0n),
  ])) as [[bigint, bigint], bigint];

  const borrowerTokensBefore = await loanNft.getUserTokens(borrower.address);
  const tx = await vbl.connect(deployer).finalizeMatch(borrowIntent, [lendIntent], sigBorrower, [sigLender]);
  const receipt = await tx.wait();

  if (assertFeesOnCreate) {
    const platformAfter = (await usdc.balanceOf(platformTreasury)) as bigint;
    const ecoAfter = (await usdc.balanceOf(ecosystemVault)) as bigint;
    const platformDelta = platformAfter - platformBefore;
    const ecoDelta = ecoAfter - ecoBefore;
    const expectedPlatform = calcFeeBps(borrowAmt, platformFeeBps);
    const expectedEco = calcFeeBps(borrowAmt, ecoFeeBps);
    const [opsAfter, statsAfter] = (await Promise.all([
      feeRouter.getOperationStats().catch(() => [0n, 0n] as const),
      feeRouter.getFeeStatistics(usdc.target, feeTypeNormal).catch(() => 0n),
    ])) as [[bigint, bigint], bigint];

    console.log(
      `  ℹ️  FeeRouter config: platformBps=${platformFeeBps.toString()} ecoBps=${ecoFeeBps.toString()} ` +
        `platformTreasury=${shortAddr(platformTreasury)} ecosystemVault=${shortAddr(ecosystemVault)}`
    );

    // SSOT (Architecture-Guide): fee routing is via FeeRouter.distributeNormal; event amounts are authoritative.
    // We assert event split AND then assert balance deltas in a way that supports dirty configs where both
    // treasuries may intentionally be the same address.
    let found = false;
    let evtPlatform = 0n;
    let evtEco = 0n;
    for (const log of receipt!.logs) {
      try {
        const parsed = feeRouter.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === "FeeDistributed") {
          const token = String(parsed.args.token).toLowerCase();
          const pAmt = parsed.args.platformAmount as bigint;
          const eAmt = parsed.args.ecoAmount as bigint;
          if (token === usdc.target.toLowerCase()) {
            if (pAmt !== expectedPlatform || eAmt !== expectedEco) {
              throw new Error(
                `[FeeDistribution] FeeDistributed mismatch: token=${token} ` +
                  `platform=${pAmt.toString()} expected=${expectedPlatform.toString()} ` +
                  `eco=${eAmt.toString()} expected=${expectedEco.toString()}`
              );
            }
            evtPlatform = pAmt;
            evtEco = eAmt;
            found = true;
            break;
          }
        }
      } catch {
        // ignore non-feerouter logs
      }
    }
    if (!found) throw new Error("[FeeDistribution] FeeDistributed event not found for borrow asset");

    const sameTreasury = platformTreasury.toLowerCase() === ecosystemVault.toLowerCase();
    if (sameTreasury) {
      const total = evtPlatform + evtEco;
      // If both treasuries point to the same address, both deltas observe the same account change.
      if (platformDelta !== total || ecoDelta !== total) {
        throw new Error(
          `[FeeDistribution] (sameTreasury) treasury delta mismatch: ` +
            `delta=${platformDelta.toString()} expectedTotal=${total.toString()}`
        );
      }
    } else {
      if (platformDelta !== evtPlatform || ecoDelta !== evtEco) {
        throw new Error(
          `[FeeDistribution] treasury deltas mismatch: ` +
            `platform got=${platformDelta.toString()} expected=${evtPlatform.toString()} ` +
            `eco got=${ecoDelta.toString()} expected=${evtEco.toString()}`
        );
      }
    }

    // Extra SSOT checks for dirty-state robustness: internal stats must advance by exactly this distribution.
    // FeeRouter increments feeStatistics[token][feeType] and operation stats on every distribution.
    const opsDeltaDist = opsAfter[0] - opsBefore[0];
    const opsDeltaAmt = opsAfter[1] - opsBefore[1];
    const statsDelta = statsAfter - statsBefore;
    if (opsDeltaDist !== 1n || opsDeltaAmt !== borrowAmt || statsDelta !== borrowAmt) {
      throw new Error(
        `[FeeDistribution] stats mismatch: ` +
          `op.distributions delta=${opsDeltaDist.toString()} expected=1 ` +
          `op.totalAmount delta=${opsDeltaAmt.toString()} expected=${borrowAmt.toString()} ` +
          `feeStatistics delta=${statsDelta.toString()} expected=${borrowAmt.toString()}`
      );
    }

    console.log(
      `  ✅ FeeDistribution OK: platform=${fmtAmountShared(expectedPlatform, 6)} USDC -> ${shortAddr(platformTreasury)}, ` +
        `eco=${fmtAmountShared(expectedEco, 6)} USDC -> ${shortAddr(ecosystemVault)}`
    );
  }

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
  const newTokenId = borrowerTokensAfter.find((t: bigint) => !borrowerTokensBefore.includes(t));
  console.log(`Created orderId=${orderId.toString()} LoanNFT.tokenId=${newTokenId?.toString() ?? "<unknown>"}`);

  if (opts.makeOverdue) {
    // Make it overdue so liquidation path is available.
    const termSec = BigInt(termDays) * ONE_DAY;
    await ethers.provider.send("evm_increaseTime", [Number(termSec + 60n)]);
    await ethers.provider.send("evm_mine", []);
    const nowAfter = (await ethers.provider.getBlock("latest"))!.timestamp;
    await po.connect(deployer).updatePrice(usdc.target, ethers.parseUnits("1", 8), nowAfter);
    if (useNonStableCollateral) {
      // Best-effort: refresh collateral price in fresh/unreasonable/bad_decimals modes (stale mode intentionally stays stale)
      if (collateralPriceMode === "fresh") {
        await po.connect(deployer).updatePrice(collateralAssetAddr, ethers.parseUnits("2000", 8), nowAfter);
      } else if (collateralPriceMode === "unreasonable") {
        await po.connect(deployer).updatePrice(collateralAssetAddr, 10n ** 13n, nowAfter);
      } else if (collateralPriceMode === "bad_decimals") {
        await po.connect(deployer).updatePrice(collateralAssetAddr, ethers.parseUnits("2000", 4), nowAfter);
      }
    }
  }

  return { orderId, borrower: borrower.address, keeper: keeper.address };
}

async function runOracleEdgeChecks() {
  // Optional suite (B): exercise PriceOracle strict behavior AND GracefulDegradation valuation fallback paths.
  if (process.env.RUN_ORACLE_EDGE !== "1") {
    console.log("=== (B) Oracle edge checks: skipped (set RUN_ORACLE_EDGE=1 to enable) ===\n");
    return;
  }
  console.log("=== (B) Oracle edge checks (stale/unreasonable/decimals) ===");

  const signers = await ethers.getSigners();
  const deployer = signers[0];

  const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;
  const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", CONTRACT_ADDRESSES.PriceOracle)) as any;
  const aw = (await ethers.getContractAt("AssetWhitelist", CONTRACT_ADDRESSES.AssetWhitelist)) as any;

  const ACTION_ADD_WHITELIST = key("ADD_WHITELIST");
  const ACTION_UPDATE_PRICE = key("UPDATE_PRICE");
  const ACTION_SET_PARAMETER = key("SET_PARAMETER");
  if (!(await acm.hasRole(ACTION_ADD_WHITELIST, deployer.address))) await acm.grantRole(ACTION_ADD_WHITELIST, deployer.address);
  if (!(await acm.hasRole(ACTION_UPDATE_PRICE, deployer.address))) await acm.grantRole(ACTION_UPDATE_PRICE, deployer.address);
  if (!(await acm.hasRole(ACTION_SET_PARAMETER, deployer.address))) await acm.grantRole(ACTION_SET_PARAMETER, deployer.address);

  const mockErc20Factory = await ethers.getContractFactory("MockERC20");
  const mock = await mockErc20Factory.deploy("MockWETH", "mWETH", ethers.parseUnits("1000000", 18));
  await mock.waitForDeployment();
  const token = mock.target as string;

  if (!(await aw.isAssetAllowed(token))) await aw.connect(deployer).addAllowedAsset(token);

  // Wrapper contract to call GracefulDegradation library in a deterministic way.
  const gdFactory = await ethers.getContractFactory("TestGracefulDegradation");
  const gd = await gdFactory.deploy();
  await gd.waitForDeployment();

  const settlementToken = CONTRACT_ADDRESSES.MockUSDC;
  const cfg = await gd.createDefaultConfig(settlementToken);
  const amount = ethers.parseUnits("10", 18);
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  const expectedFallback = (amount * 5000n) / 10_000n; // conservativeRatio=50%

  // 1) Fresh price -> strict oracle ok, GD usedFallback=false.
  await po.connect(deployer).configureAsset(token, "mock-weth", 8, 3600);
  await po.connect(deployer).updatePrice(token, ethers.parseUnits("2000", 8), now);
  const strict = await po.getPrice(token);
  if ((strict[0] as bigint) === 0n) throw new Error("[OracleEdge] strict getPrice returned zero price unexpectedly");
  const rFresh = await gd.getAssetValueWithFallback(po.target, token, amount, cfg);
  if (rFresh.usedFallback) throw new Error(`[OracleEdge] expected usedFallback=false for fresh price, got reason=${rFresh.reason}`);

  // 2) Stale price -> strict oracle should revert, GD should fallback to conservative value.
  await po.connect(deployer).configureAsset(token, "mock-weth", 8, 1); // maxPriceAge = 1 sec
  await po.connect(deployer).updatePrice(token, ethers.parseUnits("2000", 8), now - 10);
  await mustRevert("OracleEdge.strictStale", po.getPrice(token), ["StalePrice", "PriceOracle__StalePrice"]);
  const rStale = await gd.getAssetValueWithFallback(po.target, token, amount, cfg);
  if (!rStale.usedFallback || (rStale.value as bigint) !== expectedFallback) {
    throw new Error(
      `[OracleEdge] stale fallback mismatch: usedFallback=${String(rStale.usedFallback)} value=${(rStale.value as bigint).toString()} expected=${expectedFallback.toString()} reason=${rStale.reason}`
    );
  }

  // 3) Unreasonable price -> GD should fallback (maxReasonablePrice default is 1e12).
  await po.connect(deployer).configureAsset(token, "mock-weth", 8, 3600);
  await po.connect(deployer).updatePrice(token, 10n ** 13n, now); // > 1e12 => unreasonable
  const rUnreasonable = await gd.getAssetValueWithFallback(po.target, token, amount, cfg);
  if (!rUnreasonable.usedFallback || (rUnreasonable.value as bigint) !== expectedFallback) {
    throw new Error(
      `[OracleEdge] unreasonable fallback mismatch: usedFallback=${String(rUnreasonable.usedFallback)} value=${(rUnreasonable.value as bigint).toString()} expected=${expectedFallback.toString()} reason=${rUnreasonable.reason}`
    );
  }

  // 4) Invalid decimals (<6) -> GD should fallback.
  await po.connect(deployer).configureAsset(token, "mock-weth", 4, 3600);
  await po.connect(deployer).updatePrice(token, ethers.parseUnits("2000", 4), now);
  const rBadDecimals = await gd.getAssetValueWithFallback(po.target, token, amount, cfg);
  if (!rBadDecimals.usedFallback || (rBadDecimals.value as bigint) !== expectedFallback) {
    throw new Error(
      `[OracleEdge] badDecimals fallback mismatch: usedFallback=${String(rBadDecimals.usedFallback)} value=${(rBadDecimals.value as bigint).toString()} expected=${expectedFallback.toString()} reason=${rBadDecimals.reason}`
    );
  }

  console.log("  ✅ Oracle edge checks OK (strict stale reverts; valuation falls back deterministically).\n");
}

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const keeper = signers[1];
  const signerByAddr = new Map<string, any>(signers.map((s) => [s.address.toLowerCase(), s]));

  const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;

  const vaultCoreAddr = (await registry.getModuleOrRevert(key("VAULT_CORE"))) as string;
  const settlementManagerAddr = (await registry.getModuleOrRevert(key("SETTLEMENT_MANAGER"))) as string;
  const collateralManagerAddr = (await registry.getModuleOrRevert(key("COLLATERAL_MANAGER"))) as string;
  const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;
  const feeRouterAddr = (await registry.getModuleOrRevert(key("FEE_ROUTER"))) as string;
  const lenderPoolVaultAddr = (await registry.getModuleOrRevert(key("LENDER_POOL_VAULT"))) as string;
  const liquidationManagerAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_MANAGER"))) as string;
  const liquidationPayoutManagerAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_PAYOUT_MANAGER"))) as string;

  const vaultCore = (await ethers.getContractAt("VaultCore", vaultCoreAddr)) as any;
  const settlementManager = (await ethers.getContractAt("SettlementManager", settlementManagerAddr)) as any;
  const feeRouter = (await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", feeRouterAddr)) as any;
  const lpm = await ethers.getContractAt(
    ["function getRecipients() view returns (tuple(address platform,address reserve,address lenderCompensation))"],
    liquidationPayoutManagerAddr
  );

  const platformTreasury = (await feeRouter.getPlatformTreasury()) as string;
  const ecosystemVault = (await feeRouter.getEcosystemVault()) as string;
  const recipients = (await lpm.getRecipients()) as { platform: string; reserve: string; lenderCompensation: string };

  const runRepay = process.env.RUN_REPAY !== "0";
  const runLiquidation = process.env.RUN_LIQUIDATION !== "0";
  const createIfMissing = process.env.CREATE_ORDER !== "0";

  // Prefer using "clean" signers (no existing debt/collateral) so strict repay mode (requireFullRepayRelease)
  // does not revert due to the user having *other* active debt.
  const vle = await ethers.getContractAt(
    ["function getUserTotalDebtValue(address user) view returns (uint256)"],
    CONTRACT_ADDRESSES.VaultLendingEngine
  );
  const cm = await ethers.getContractAt(
    ["function getUserCollateralAssets(address user) view returns (address[])"],
    collateralManagerAddr
  );

  const isCleanUser = async (addr: string) => {
    const [debtValue, assets] = await Promise.all([
      (vle.getUserTotalDebtValue(addr) as Promise<bigint>),
      (cm.getUserCollateralAssets(addr) as Promise<string[]>).catch(() => [] as string[]),
    ]);
    return debtValue === 0n && (assets?.length ?? 0) === 0;
  };

  const pickCleanSigner = async (exclude: Set<string>) => {
    for (let i = 2; i < signers.length; i++) {
      const s = signers[i];
      const a = s.address.toLowerCase();
      if (exclude.has(a)) continue;
      if (await isCleanUser(s.address)) {
        exclude.add(a);
        return s;
      }
    }
    throw new Error(
      "No clean signer found (no-debt/no-collateral). Restart localhost node for a clean state, or use E2E_ALLOW_DIRTY_STATE flows."
    );
  };

  const pickAnySigner = (exclude: Set<string>) => {
    for (let i = 2; i < signers.length; i++) {
      const s = signers[i];
      const a = s.address.toLowerCase();
      if (exclude.has(a)) continue;
      exclude.add(a);
      return s;
    }
    throw new Error("No unused signer available.");
  };

  // Support using different orders for repay and liquidation, since these actions mutate the order state.
  let orderIdRepay: bigint | null = process.env.ORDER_ID_REPAY ? BigInt(process.env.ORDER_ID_REPAY) : null;
  let orderIdLiq: bigint | null = process.env.ORDER_ID_LIQ ? BigInt(process.env.ORDER_ID_LIQ) : null;

  if (process.env.ORDER_ID) {
    const single = BigInt(process.env.ORDER_ID);
    if (runRepay && runLiquidation) {
      throw new Error(
        "ORDER_ID is set but both RUN_REPAY and RUN_LIQUIDATION are enabled. " +
          "Provide ORDER_ID_REPAY and ORDER_ID_LIQ (recommended), or disable one action."
      );
    }
    if (runRepay) orderIdRepay = single;
    if (runLiquidation) orderIdLiq = single;
  }

  if (createIfMissing) {
    const exclude = new Set<string>([deployer.address.toLowerCase(), keeper.address.toLowerCase()]);
    if (runLiquidation && !orderIdLiq) {
      const borrowerSigner = await pickCleanSigner(exclude);
      const lenderSigner = pickAnySigner(exclude);
      const created = await createOrder({ makeOverdue: true, borrowerSigner, lenderSigner, keeperSigner: keeper });
      orderIdLiq = created.orderId;
    }
    if (runRepay && !orderIdRepay) {
      const borrowerSigner = await pickCleanSigner(exclude);
      const lenderSigner = pickAnySigner(exclude);
      const created = await createOrder({ makeOverdue: false, borrowerSigner, lenderSigner, keeperSigner: keeper });
      orderIdRepay = created.orderId;
    }
  }

  if (runLiquidation && !orderIdLiq) {
    throw new Error("Missing liquidation order id. Set ORDER_ID_LIQ=<N> (or CREATE_ORDER=1 to auto-create).");
  }
  if (runRepay && !orderIdRepay) {
    throw new Error("Missing repay order id. Set ORDER_ID_REPAY=<N> (or CREATE_ORDER=1 to auto-create).");
  }

  console.log("=== Funds Conservation Smoke (localhost) ===\n");

  await runOracleEdgeChecks();

  // ============ A) Liquidation conservation (overdue) ============
  // This checks that seized collateral distribution does not mint/burn and stays within tracked addresses.
  if (runLiquidation) {
    const orderId = orderIdLiq!;
    const ord = await getOrderForView(orderEngineAddr, orderId);
    const tokenMeta = await getErc20Meta(ord.asset);
    const symbol = tokenMeta.symbol;
    const decimals = tokenMeta.decimals;

    const tracked = await discoverTrackedAddresses({
      include: [deployer.address],
      borrower: ord.borrower,
      lender: ord.lender,
      keeper: keeper.address,
    });

    console.log("=== A) Liquidation conservation (settleOrLiquidate) ===");
    console.log(`Order: ${orderId.toString()}`);
    console.log(`Token: ${symbol} @ ${ord.asset}`);
    console.log(`Borrower: ${ord.borrower}`);
    console.log(`Lender(order.lender): ${ord.lender}`);
    console.log("");
    const tokenUniverseBaseNow = await getTokenUniverse({
      assetWhitelistAddr: CONTRACT_ADDRESSES.AssetWhitelist,
      priceOracleAddr: CONTRACT_ADDRESSES.PriceOracle,
      feeRouterAddr,
      extra: [CONTRACT_ADDRESSES.MockUSDC],
    });
    console.log(
      `TokenUniverseNow(${tokenUniverseBaseNow.length}): ${tokenUniverseBaseNow.map(shortAddr).join(", ") || "<empty>"}`
    );
    const tokenUniverse = uniqAddrs([...tokenUniverseBaseNow, ord.asset]);
    const beforeMany = await snapshotBalancesMany(tokenUniverse, tracked);

    // Production-like mode: require keeper has ACTION_LIQUIDATE (no auto-grant inside smoke).
    {
      const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;
      const ACTION_LIQUIDATE = key("LIQUIDATE");
      const has = await acm.hasRole(ACTION_LIQUIDATE, keeper.address);
      if (!has) {
        throw new Error(
          `[AccessControl] keeper missing ACTION_LIQUIDATE (${keeper.address}). ` +
            `Grant roles before running this smoke (see scripts/tests/README.md).`
        );
      }
    }

    // Note: settleOrLiquidate may choose settle vs liquidate; in our created flow it is overdue=true.
    // In valuation-edge scenarios (e.g. stale collateral price), liquidation may revert (e.g. NoCollateral).
    // Allow turning this into an expected, *explicit* assertion so batch runs can continue.
    const expectedLiqReverts = (process.env.EXPECT_LIQUIDATION_REVERT ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean); // CSV: e.g. SettlementManager__NoCollateral,0x66e24701
    let reverted: string | null = null;
    try {
      await (await settlementManager.connect(keeper).settleOrLiquidate(orderId)).wait();
    } catch (e: any) {
      reverted = String(e?.message ?? e);
      if (!expectedLiqReverts.length) throw e;
      const { needles, selectors } = buildExpectedRevertMatchers(expectedLiqReverts);
      const actualSelector = tryExtractRevertSelector(e);
      const okByMsg = needles.some((h) => reverted!.includes(h));
      const okBySelector = !!actualSelector && selectors.some((s) => s === actualSelector);
      if (!okByMsg && !okBySelector) {
        throw new Error(
          `[Liquidation] reverted, but did not match EXPECT_LIQUIDATION_REVERT=${expectedLiqReverts.join(",")}: ${reverted}\n` +
            `  expectedSelectors=${JSON.stringify(selectors)} actualSelector=${actualSelector ?? "<none>"}`
        );
      }
      const matched =
        (okBySelector && actualSelector) ||
        expectedLiqReverts.find((h) => reverted!.includes(h)) ||
        (actualSelector ?? "<unknown>");
      console.log(
        `  ✅ Expected liquidation revert observed: ${matched} (selector=${actualSelector ?? "n/a"})`
      );
    }
    const afterMany = await snapshotBalancesMany(tokenUniverse, tracked);

    assertConservationMany("Liquidation", beforeMany, afterMany);
    console.log(
      `  ✅ OK: totalSupply unchanged; sumTracked conserved across ${beforeMany.size} tokens (including ${symbol})\n`
    );
  }

  // ============ B) Repay conservation (full repay) ============
  if (runRepay) {
    const orderId = orderIdRepay!;
    const ord = await getOrderForView(orderEngineAddr, orderId);
    const tokenMeta = await getErc20Meta(ord.asset);
    const symbol = tokenMeta.symbol;
    const decimals = tokenMeta.decimals;

    const tracked = await discoverTrackedAddresses({
      include: [deployer.address],
      borrower: ord.borrower,
      lender: ord.lender,
      keeper: keeper.address,
    });

    console.log("=== B) Repay conservation (VaultCore.repay full) ===");
    console.log(`Order: ${orderId.toString()}`);
    console.log(`Token: ${symbol} @ ${ord.asset}`);
    console.log(`Borrower: ${ord.borrower}`);
    console.log(`Lender(order.lender): ${ord.lender}`);
    console.log("");

    const remainingPrincipal = ord.principal > ord.repaidAmount ? ord.principal - ord.repaidAmount : 0n;
    const remainingDue = remainingPrincipal + calcInterest(ord.principal, ord.rate, ord.term);
    if (remainingDue === 0n) {
      console.log("  ℹ️  remainingDue is zero; skipping repay conservation.\n");
      return;
    }

    const tokenUniverseBaseNow = await getTokenUniverse({
      assetWhitelistAddr: CONTRACT_ADDRESSES.AssetWhitelist,
      priceOracleAddr: CONTRACT_ADDRESSES.PriceOracle,
      feeRouterAddr,
      extra: [CONTRACT_ADDRESSES.MockUSDC],
    });
    console.log(
      `TokenUniverseNow(${tokenUniverseBaseNow.length}): ${tokenUniverseBaseNow.map(shortAddr).join(", ") || "<empty>"}`
    );
    const tokenUniverse = uniqAddrs([...tokenUniverseBaseNow, ord.asset]);
    const beforeMany = await snapshotBalancesMany(tokenUniverse, tracked);
    const borrowerSigner = signerByAddr.get(ord.borrower.toLowerCase());
    if (!borrowerSigner) {
      throw new Error(
        `[Config] borrower ${ord.borrower} is not an available local signer. ` +
          "Provide ORDER_ID_REPAY for an order whose borrower is one of hardhat signers, or create a new order (CREATE_ORDER=1)."
      );
    }
    const debtToken = tokenMeta.erc20 as any;

    await (await debtToken.connect(borrowerSigner).approve(vaultCoreAddr, remainingDue)).wait();
    await (await vaultCore.connect(borrowerSigner).repay(orderId, ord.asset, remainingDue)).wait();

    const afterMany = await snapshotBalancesMany(tokenUniverse, tracked);
    assertConservationMany("Repay", beforeMany, afterMany);
    console.log(`  ✅ OK: totalSupply unchanged; sumTracked conserved across ${beforeMany.size} tokens (including ${symbol})\n`);
  }

  console.log("✅ Funds Conservation Smoke Completed!");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

