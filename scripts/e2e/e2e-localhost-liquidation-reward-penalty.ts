import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost.ts";
import { runViewPreflight } from "./utils/view-preflight.ts";

const ONE_HOUR_BLOCKS = 1_800n;

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function assertOk(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function isZeroAddr(addr: string | undefined | null): boolean {
  return !addr || addr === ethers.ZeroAddress;
}

function fmtErr(e: any) {
  return e?.shortMessage ?? e?.message ?? String(e);
}

function mkArtifactsWriter() {
  const outDir = path.join(__dirname, "artifacts");
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch {
    // ignore
  }
  return {
    outDir,
    writeJson: (name: string, data: unknown) => {
      const p = path.join(outDir, name);
      const replacer = (_k: string, v: any) => (typeof v === "bigint" ? v.toString() : v);
      fs.writeFileSync(p, JSON.stringify(data, replacer, 2) + "\n", "utf8");
      return p;
    },
  };
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

async function waitTx(p: Promise<any>, label: string) {
  const tx = await p;
  const rc = await tx.wait();
  assertOk(!!rc, `${label}: missing receipt`);
  return rc;
}

async function deployUnavailableRewardView(): Promise<string> {
  const factory = await ethers.getContractFactory("MockRewardViewUnavailable");
  const mock = await factory.deploy();
  await mock.waitForDeployment();
  return await mock.getAddress();
}

async function advanceRewardViewCacheTtl() {
  await ethers.provider.send("hardhat_mine", [ethers.toBeHex(1_801)]);
}

async function advanceBlocks(blocks: bigint) {
  if (blocks <= 0n) return;
  await ethers.provider.send("hardhat_mine", [ethers.toBeHex(blocks)]);
}

// Robust across both event shapes:
// - DataPushed(bytes32 indexed dataTypeHash, bytes payload)
// - DataPushed(bytes32 dataTypeHash, bytes payload)
const coder = ethers.AbiCoder.defaultAbiCoder();
const DATA_PUSH_TOPIC0 = ethers.keccak256(ethers.toUtf8Bytes("DataPushed(bytes32,bytes)")).toLowerCase();
const PUSH_FAILED_IFACE = new ethers.Interface([
  "event RewardViewPushFailed(address indexed user, address indexed rewardView, bytes32 indexed op, bytes payload, bytes reason)",
]);
const REWARD_VIEW_PUSH_FAILED_TOPIC0 = ethers.id(
  "RewardViewPushFailed(address,address,bytes32,bytes,bytes)"
).toLowerCase();
const REWARD_VIEW_UNAVAILABLE_REASON_HEX = ethers.hexlify(ethers.toUtf8Bytes("rewardView unavailable")).toLowerCase();

function extractDataPushed(receipt: any, viewAddr: string): Array<{ dataTypeHash: string; payload: string }> {
  const out: Array<{ dataTypeHash: string; payload: string }> = [];
  const addr = viewAddr.toLowerCase();
  for (const log of receipt?.logs ?? []) {
    if (String(log.address).toLowerCase() !== addr) continue;
    const topics = (log.topics ?? []) as string[];
    if (!topics.length) continue;
    if (String(topics[0]).toLowerCase() !== DATA_PUSH_TOPIC0) continue;

    try {
      if (topics.length >= 2) {
        // indexed(bytes32) => topic1 is dataTypeHash; data only has payload
        const dataTypeHash = String(topics[1]);
        const [payload] = coder.decode(["bytes"], log.data) as unknown as [string];
        out.push({ dataTypeHash, payload });
      } else {
        const [dataTypeHash, payload] = coder.decode(["bytes32", "bytes"], log.data) as unknown as [string, string];
        out.push({ dataTypeHash: String(dataTypeHash), payload: String(payload) });
      }
    } catch {
      // ignore
    }
  }
  return out;
}

function extractRewardViewPushFailed(
  receipt: any,
  emitter: string
): Array<{ user: string; rewardView: string; op: string; payload: string; reason: string }> {
  const out: Array<{ user: string; rewardView: string; op: string; payload: string; reason: string }> = [];
  for (const log of receipt?.logs ?? []) {
    if (String(log.address).toLowerCase() !== emitter.toLowerCase()) continue;
    const topics = (log.topics ?? []) as string[];
    if (!topics.length || String(topics[0]).toLowerCase() !== REWARD_VIEW_PUSH_FAILED_TOPIC0) continue;
    try {
      const parsed = PUSH_FAILED_IFACE.parseLog({ topics, data: log.data });
      if (!parsed) continue;
      out.push({
        user: String(parsed.args.user),
        rewardView: String(parsed.args.rewardView),
        op: String(parsed.args.op).toLowerCase(),
        payload: String(parsed.args.payload),
        reason: ethers.hexlify(ethers.getBytes(parsed.args.reason)).toLowerCase(),
      });
    } catch {
      // ignore
    }
  }
  return out;
}

function buildLendIntentHash(li: any) {
  const typeHash = ethers.keccak256(
    ethers.toUtf8Bytes(
      "LendIntent(address lenderSigner,address asset,uint256 amount,uint16 minTermDays,uint16 maxTermDays,uint256 minRateBps,uint256 expireAt,bytes32 salt)"
    )
  );
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

async function assertHasCode(addr: string, label: string) {
  const code = await ethers.provider.getCode(addr);
  if (!code || code === "0x") {
    throw new Error(`[E2E Preflight] No bytecode at ${label}: ${addr}`);
  }
}

function extractOrderIdFromReceipt(receipt: any, orderEngine: any, orderEngineAddr: string): bigint | null {
  for (const log of receipt.logs ?? []) {
    try {
      if (String(log.address).toLowerCase() !== String(orderEngineAddr).toLowerCase()) continue;
      const parsed = orderEngine.interface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "LoanOrderCreated") {
        return parsed.args.orderId as bigint;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

export async function runLiquidationRewardPenalty() {
  const snap = await network.provider.send("evm_snapshot", []);
  const artifacts = mkArtifactsWriter();

  const STRICT_VIEWS = (process.env.E2E_STRICT_VIEWS ?? "1") !== "0";
  const STRICT_DATAPUSH = (process.env.E2E_STRICT_DATAPUSH ?? "0") === "1";
  const STRICT_REWARD = (process.env.E2E_STRICT_REWARD ?? "0") === "1";

  const out: any = {
    name: "liquidation-reward-penalty",
    generatedAt: new Date().toISOString(),
    chainId: String((await ethers.provider.getNetwork()).chainId),
    rpcUrl: process.env.LOCALHOST_RPC_URL ?? "",
    strict: { views: STRICT_VIEWS, datapush: STRICT_DATAPUSH, reward: STRICT_REWARD },
    steps: [],
  };

  try {
    await assertHasCode(CONTRACT_ADDRESSES.Registry, "Registry");

    const [deployer, borrower, lender] = await ethers.getSigners();

    const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
    const acmAddr = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
    const assetWhitelistAddr = (await registry.getModuleOrRevert(key("ASSET_WHITELIST"))) as string;
    const priceOracleAddr = (await registry.getModuleOrRevert(key("PRICE_ORACLE"))) as string;
    const feeRouterAddr = (await registry.getModuleOrRevert(key("FEE_ROUTER"))) as string;

    const settlementManagerAddr = (await registry.getModuleOrRevert(key("SETTLEMENT_MANAGER"))) as string;
    const vaultCoreAddr = (await registry.getModuleOrRevert(key("VAULT_CORE"))) as string;
    const vblAddr = (await registry.getModuleOrRevert(key("VAULT_BUSINESS_LOGIC"))) as string;
    const cmAddr = (await registry.getModuleOrRevert(key("COLLATERAL_MANAGER"))) as string;
    const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;
    const vaultLendingEngineAddr = (await registry.getModuleOrRevert(key("LENDING_ENGINE"))) as string;
    const liquidationViewAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_VIEW"))) as string;
    const guaranteeFundManagerAddr = (await registry.getModuleOrRevert(key("GUARANTEE_FUND_MANAGER"))) as string;

    const rewardViewAddr = (await registry.getModule(key("REWARD_VIEW"))) as string;
    const rewardManagerAddr = (await registry.getModule(key("REWARD_MANAGER"))) as string;
    const rewardAccrualManagerAddr = (await registry.getModule(key("REWARD_ACCRUAL_MANAGER"))) as string;
    const rewardManagerCoreAddr = (await registry.getModuleOrRevert(key("REWARD_MANAGER_CORE"))) as string;

    const settlementTokenAddr = (await registry.getModuleOrRevert(key("SETTLEMENT_TOKEN"))) as string;
    const easyTokenAddr = (await registry.getModuleOrRevert(key("EASY_TOKEN"))) as string;

    const acm = (await ethers.getContractAt("AccessControlManager", acmAddr)) as any;
    const awRead = (await ethers.getContractAt("IAssetWhitelistRead", assetWhitelistAddr)) as any;
    const awAdmin = (await ethers.getContractAt("IAssetWhitelistAdmin", assetWhitelistAddr)) as any;
    const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", priceOracleAddr)) as any;
    const feeRouter = (await ethers.getContractAt("FeeRouter", feeRouterAddr)) as any;

    const settlementManager = (await ethers.getContractAt(
      "src/Vault/liquidation/modules/SettlementManager.sol:SettlementManager",
      settlementManagerAddr
    )) as any;
    const vaultCore = (await ethers.getContractAt("VaultCore", vaultCoreAddr)) as any;
    const vbl = (await ethers.getContractAt("VaultBusinessLogic", vblAddr)) as any;
    const cm = (await ethers.getContractAt("CollateralManager", cmAddr)) as any;
    const orderEngine = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", orderEngineAddr)) as any;
    const vle = (await ethers.getContractAt(
      "src/Vault/modules/VaultLendingEngine.sol:VaultLendingEngine",
      vaultLendingEngineAddr
    )) as any;

    const usdc = (await ethers.getContractAt("MockERC20", settlementTokenAddr)) as any;
    const easyToken = (await ethers.getContractAt("EasyToken", easyTokenAddr)) as any;

    const rewardView = !isZeroAddr(rewardViewAddr)
      ? ((await ethers.getContractAt("RewardView", rewardViewAddr)) as any)
      : null;
    const rewardManager = !isZeroAddr(rewardManagerAddr)
      ? ((await ethers.getContractAt("RewardManager", rewardManagerAddr)) as any)
      : null;
    const rewardAccrualManager = !isZeroAddr(rewardAccrualManagerAddr)
      ? ((await ethers.getContractAt("RewardAccrualManager", rewardAccrualManagerAddr)) as any)
      : null;

    if (STRICT_VIEWS || STRICT_DATAPUSH || STRICT_REWARD) {
      await runViewPreflight({
        registryAddr: CONTRACT_ADDRESSES.Registry,
        acmAddr,
        adminSigner: deployer,
        assetForPriceCheck: settlementTokenAddr,
      });
    }

    const ensureRole = async (roleName: string, who: string) => {
      const role = key(roleName);
      const ok = (await acm.hasRole(role, who)) as boolean;
      if (!ok) await (await acm.connect(deployer).grantRole(role, who)).wait();
    };

    // Ensure minimal permissions for the flow on localhost.
    await ensureRole("ADD_WHITELIST", deployer.address);
    await ensureRole("SET_PARAMETER", deployer.address);
    await ensureRole("UPDATE_PRICE", deployer.address);
    await ensureRole("ORDER_CREATE", vblAddr);
    await ensureRole("DEPOSIT", vblAddr);
    await ensureRole("BORROW", orderEngineAddr);
    await ensureRole("REPAY", settlementManagerAddr);
    await ensureRole("LIQUIDATE", deployer.address);

    // Ensure settlement token is allowed and price-configured.
    if (!(await awRead.isAssetAllowed(settlementTokenAddr))) {
      await waitTx(awAdmin.connect(deployer).addAllowedAsset(settlementTokenAddr), "addAllowedAsset settlement");
    }

    if (!(await feeRouter.isTokenSupported(settlementTokenAddr))) {
      await waitTx(feeRouter.connect(deployer).addSupportedToken(settlementTokenAddr), "addSupportedToken settlement");
    }

    try {
      const cfg = await po.getAssetConfig(settlementTokenAddr);
      if (!cfg.isActive) {
        const decimals = Number(await usdc.decimals());
        await waitTx(po.connect(deployer).configureAsset(settlementTokenAddr, "usd-coin", decimals, 3600), "configureAsset");
      }
    } catch {
      // best-effort
    }

    // Ensure price is written for valuation helpers used by liquidation.
    // NOTE: PriceOracle.getPrice() reverts if price is missing/invalid, so we cannot probe it first.
    // SSOT: price follows asset decimals ($1.00 => 1 * 10**assetDecimals).
    try {
      const bn = await ethers.provider.getBlockNumber();
      const settlementTokenDecimals = Number(await usdc.decimals().catch(() => 6));
      await waitTx(
        po.connect(deployer).updatePrice(settlementTokenAddr, ethers.parseUnits("1", settlementTokenDecimals), bn),
        "updatePrice settlement"
      );
    } catch {
      // best-effort
    }

    // Fund borrower + lender with settlement token for reserve/deposit.
    const decimals = Number(await usdc.decimals());
    const fundAmt = ethers.parseUnits("5000000", decimals);
    try {
      await waitTx(usdc.connect(deployer).mint(borrower.address, fundAmt), "fund borrower mint");
      await waitTx(usdc.connect(deployer).mint(lender.address, fundAmt), "fund lender mint");
    } catch {
      await waitTx(usdc.connect(deployer).transfer(borrower.address, fundAmt), "fund borrower transfer");
      await waitTx(usdc.connect(deployer).transfer(lender.address, fundAmt), "fund lender transfer");
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

    // 1) Create one overdue-liquidatable order.
    const principal = ethers.parseUnits("1000", decimals);
    const collateral = principal * 3n;
    const rateBps = 1000n;
    const termDays = 5;
    const expireAt = (await latestBlockNumber()) + ONE_HOUR_BLOCKS;

    const borrowIntent = {
      borrower: borrower.address,
      collateralAsset: settlementTokenAddr,
      collateralAmount: collateral,
      borrowAsset: settlementTokenAddr,
      amount: principal,
      termDays,
      rateBps,
      expireAt,
      salt: ethers.keccak256(ethers.toUtf8Bytes(`liq-reward-borrow-${Date.now()}`)),
    };

    const lendIntent = {
      lenderSigner: lender.address,
      asset: settlementTokenAddr,
      amount: principal,
      minTermDays: termDays,
      maxTermDays: termDays,
      minRateBps: 0n,
      expireAt,
      salt: ethers.keccak256(ethers.toUtf8Bytes(`liq-reward-lend-${Date.now()}`)),
    };

    // Approvals needed by match/guarantee/deposit path.
    const allowGfm = (await usdc.allowance(borrower.address, guaranteeFundManagerAddr)) as bigint;
    if (allowGfm < principal) {
      await waitTx(usdc.connect(borrower).approve(guaranteeFundManagerAddr, ethers.MaxUint256), "approve GFM");
    }

    await waitTx(usdc.connect(lender).approve(vblAddr, principal), "approve reserve");
    const lendHash = buildLendIntentHash(lendIntent);
    await waitTx(vbl.connect(lender).reserveForLending(lender.address, settlementTokenAddr, principal, lendHash), "reserveForLending");

    await waitTx(usdc.connect(borrower).approve(cmAddr, collateral), "approve collateral");
    await waitTx(vaultCore.connect(borrower).deposit(settlementTokenAddr, collateral), "deposit collateral");

    const sigBorrower = await borrower.signTypedData(domain, typesBorrow as any, borrowIntent as any);
    const sigLender = await lender.signTypedData(domain, typesLend as any, lendIntent as any);

    const rcMatch = await waitTx(
      vbl.connect(deployer).finalizeMatch(borrowIntent, [lendIntent], sigBorrower, [sigLender]),
      "finalizeMatch"
    );

    let orderId: bigint | null = extractOrderIdFromReceipt(rcMatch, orderEngine, orderEngineAddr);
    assertOk(orderId !== null, "LoanOrderCreated not found");

    out.steps.push({
      name: "createOrder",
      orderId: orderId!.toString(),
      borrower: borrower.address,
      lender: lender.address,
      asset: settlementTokenAddr,
      principal: principal.toString(),
      collateral: collateral.toString(),
      txHash: rcMatch.transactionHash,
    });

    // 2) Mine beyond maturity to ensure overdue.
    const ord = (await orderEngine.getLoanOrderForView(orderId)) as any;
    const maturity = BigInt(ord.maturity);
    await mineToBlock(maturity + 1n);
    out.steps.push({ name: "mineOverdue", maturity: maturity.toString(), now: (await latestBlockNumber()).toString() });

    // Refresh price after mining; otherwise PriceOracle.getPrice may revert as stale.
    try {
      const bn = await ethers.provider.getBlockNumber();
      const settlementTokenDecimals = Number(await usdc.decimals().catch(() => 6));
      await waitTx(
        po.connect(deployer).updatePrice(settlementTokenAddr, ethers.parseUnits("1", settlementTokenDecimals), bn),
        "refreshPrice settlement"
      );
    } catch {
      // best-effort
    }

    // 3) Liquidate via SettlementManager and assert: liquidation datapush exists; default guarantee can also trigger reward penalty in the same tx.
    const debtBefore = (await vle.getDebt(borrower.address, settlementTokenAddr)) as bigint;
    assertOk(debtBefore > 0n, "expected debt > 0 before liquidation");
    const pendingPenaltyBeforeLiq = rewardAccrualManager
      ? ((await rewardAccrualManager.getPenaltyDebt(borrower.address)) as bigint)
      : null;

    const rcLiq = await waitTx(settlementManager.connect(deployer).settleOrLiquidate(orderId), "settleOrLiquidate");

    const liqPushes = extractDataPushed(rcLiq, liquidationViewAddr);
    const rewardPushesOnLiq = !isZeroAddr(rewardViewAddr) ? extractDataPushed(rcLiq, rewardViewAddr) : [];

    const wantLiqUpdate = key("LIQUIDATION_UPDATE").toLowerCase();
    const wantLiqPayout = key("LIQUIDATION_PAYOUT").toLowerCase();
    const hasLiquidationDataPush = liqPushes.some(
      (p) => p.dataTypeHash.toLowerCase() === wantLiqUpdate || p.dataTypeHash.toLowerCase() === wantLiqPayout
    );
    if (STRICT_DATAPUSH) {
      assertOk(hasLiquidationDataPush, "missing liquidation DataPushed(LIQUIDATION_*)");
    }

    const hasPenaltyLedgerOnLiq = rewardPushesOnLiq.some(
      (p) => p.dataTypeHash.toLowerCase() === key("REWARD_PENALTY_LEDGER_UPDATED").toLowerCase()
    );
    const hasRewardBurnedOnLiq = rewardPushesOnLiq.some(
      (p) => p.dataTypeHash.toLowerCase() === key("REWARD_BURNED").toLowerCase()
    );
    const pendingPenaltyAfterLiq = rewardAccrualManager
      ? ((await rewardAccrualManager.getPenaltyDebt(borrower.address)) as bigint)
      : null;
    if (STRICT_REWARD && !isZeroAddr(rewardViewAddr) && pendingPenaltyBeforeLiq !== null && pendingPenaltyAfterLiq !== null) {
      if (pendingPenaltyAfterLiq > pendingPenaltyBeforeLiq) {
        assertOk(
          hasPenaltyLedgerOnLiq || hasRewardBurnedOnLiq,
          "default/liquidation increased penalty debt but missing RewardView.DataPushed(REWARD_PENALTY_LEDGER_UPDATED|REWARD_BURNED)"
        );
      }
    }

    out.steps.push({
      name: "liquidate",
      txHash: rcLiq.transactionHash,
      liquidationPushTypes: liqPushes.map((p) => p.dataTypeHash.toLowerCase()),
      rewardPushTypes: rewardPushesOnLiq.map((p) => p.dataTypeHash.toLowerCase()),
      penaltyDebtBefore: pendingPenaltyBeforeLiq?.toString() ?? null,
      penaltyDebtAfter: pendingPenaltyAfterLiq?.toString() ?? null,
    });

    // 4) Apply liquidation penalty via GFM->RewardManager (separate tx) and assert reward datapush + debt delta.
    if (!rewardManager || !rewardAccrualManager || !rewardView) {
      throw new Error(
        "Reward modules missing in Registry (need REWARD_MANAGER, REWARD_ACCRUAL_MANAGER, REWARD_VIEW)"
      );
    }

    await ethers.provider.send("hardhat_impersonateAccount", [orderEngineAddr]);
    await ethers.provider.send("hardhat_setBalance", [orderEngineAddr, "0x56BC75E2D63100000"]); // 100 ETH
    const orderEngineSigner = await ethers.getSigner(orderEngineAddr);

    const manualLedgerOrderId = orderId! + 10_000n;
    const manualLedgerMaturity = (await latestBlockNumber()) + ONE_HOUR_BLOCKS;
    await waitTx(
      rewardManager
        .connect(orderEngineSigner)
        .onLoanEventByOrder(borrower.address, manualLedgerOrderId, principal, manualLedgerMaturity, 0),
      "lock order for manual liquidation penalty ledger-path"
    );

    const debt0 = (await rewardAccrualManager.getPenaltyDebt(borrower.address)) as bigint;
    const balEasy = (await easyToken.balanceOf(borrower.address)) as bigint;
    if (balEasy > 0n) {
      await waitTx(easyToken.connect(borrower).transfer(deployer.address, balEasy), "drain borrower Easy for ledger-path");
    }
    const penaltyAmount = (await rewardManager.quoteLiquidationPenalty(borrower.address)) as bigint;
    assertOk(penaltyAmount > 0n, "expected non-zero liquidation penalty quote for ledger-path");

    // impersonate GuaranteeFundManager to satisfy RewardManager.applyLiquidationPenalty role gate
    await ethers.provider.send("hardhat_impersonateAccount", [guaranteeFundManagerAddr]);
    await ethers.provider.send("hardhat_setBalance", [guaranteeFundManagerAddr, "0x56BC75E2D63100000"]); // 100 ETH
    const gfmSigner = await ethers.getSigner(guaranteeFundManagerAddr);

    const rcPenalty = await waitTx(
      rewardManager.connect(gfmSigner).applyLiquidationPenalty(borrower.address),
      "applyLiquidationPenalty ledger-path"
    );

    const debt1 = (await rewardAccrualManager.getPenaltyDebt(borrower.address)) as bigint;
    assertOk(debt1 === debt0 + penaltyAmount, "penalty debt delta mismatch (expected +penaltyAmount)");

    const rewardPushesPenalty = extractDataPushed(rcPenalty, rewardViewAddr);
    const hasPenaltyLedger = rewardPushesPenalty.some(
      (p) => p.dataTypeHash.toLowerCase() === key("REWARD_PENALTY_LEDGER_UPDATED").toLowerCase()
    );
    const hasBurned = rewardPushesPenalty.some(
      (p) => p.dataTypeHash.toLowerCase() === key("REWARD_BURNED").toLowerCase()
    );

    if (STRICT_REWARD) {
      assertOk(
        hasPenaltyLedger || hasBurned,
        "missing RewardView.DataPushed(REWARD_PENALTY_LEDGER_UPDATED|REWARD_BURNED) on applyLiquidationPenalty tx"
      );
    }

    out.steps.push({
      name: "applyLiquidationPenaltyLedger",
      txHash: rcPenalty.transactionHash,
      penaltyAmount: penaltyAmount.toString(),
      easyBalanceBefore: balEasy.toString(),
      penaltyDebtBefore: debt0.toString(),
      penaltyDebtAfter: debt1.toString(),
      rewardPushTypes: rewardPushesPenalty.map((p) => p.dataTypeHash.toLowerCase()),
      expectLedgerPath: true,
    });

    // 5) Apply liquidation penalty again, but with sufficient Easy balance so burn succeeds (no ledger delta).
    // This is the explicit burn path: balance decreases; RewardView emits REWARD_BURNED; no penalty-ledger push.
    const burnerRole = await easyToken.BURNER_ROLE();
    if (!(await easyToken.hasRole(burnerRole, rewardAccrualManagerAddr))) {
      try {
        await waitTx(easyToken.connect(deployer).grantRole(burnerRole, rewardAccrualManagerAddr), "grant BURNER_ROLE to RewardAccrualManager");
      } catch {
        // best-effort
      }
    }

    // Mint Easy to borrower (local-only) so burn path is reachable.
    // NOTE: This mutates sole minter but the whole script is snapshotted and reverted.
    const mintAmt = ethers.parseUnits("10", 18);
    try {
      await waitTx(easyToken.connect(deployer).setSoleMinter(deployer.address), "setSoleMinter(deployer)");
      await waitTx(easyToken.connect(deployer).mint(borrower.address, mintAmt), "mint Easy to borrower");
    } catch {
      // best-effort; if mint fails we'll skip burn assertions below
    }

    const manualBurnOrderId = orderId! + 20_000n;
    const manualBurnMaturity = (await latestBlockNumber()) + ONE_HOUR_BLOCKS;
    await waitTx(
      rewardManager
        .connect(orderEngineSigner)
        .onLoanEventByOrder(borrower.address, manualBurnOrderId, principal, manualBurnMaturity, 0),
      "lock order for manual liquidation penalty burn-path"
    );

    const balEasy2 = (await easyToken.balanceOf(borrower.address)) as bigint;
    const debt2Before = (await rewardAccrualManager.getPenaltyDebt(borrower.address)) as bigint;
    const burnPenaltyAmount = (await rewardManager.quoteLiquidationPenalty(borrower.address)) as bigint;

    if (burnPenaltyAmount > 0n && balEasy2 >= burnPenaltyAmount) {
      const summary0 = await rewardView.getUserRewardSummaryWithMeta(borrower.address);
        const burned0 = summary0[0] as bigint;

      const rcPenaltyBurn = await waitTx(
        rewardManager.connect(gfmSigner).applyLiquidationPenalty(borrower.address),
        "applyLiquidationPenalty (burn-path)"
      );

      const balEasy3 = (await easyToken.balanceOf(borrower.address)) as bigint;
      const debt2After = (await rewardAccrualManager.getPenaltyDebt(borrower.address)) as bigint;

      const summary1 = await rewardView.getUserRewardSummaryWithMeta(borrower.address);
      const burned1 = summary1[0] as bigint;

      assertOk(balEasy2 - balEasy3 === burnPenaltyAmount, "burn-path: Easy balance delta mismatch");
      assertOk(debt2After === debt2Before, "burn-path: penalty debt should not change");
      assertOk(burned1 - burned0 === burnPenaltyAmount, "burn-path: RewardView.totalBurned delta mismatch");

      const rewardPushesPenaltyBurn = extractDataPushed(rcPenaltyBurn, rewardViewAddr);
      const hasPenaltyLedgerBurn = rewardPushesPenaltyBurn.some(
        (p) => p.dataTypeHash.toLowerCase() === key("REWARD_PENALTY_LEDGER_UPDATED").toLowerCase()
      );
      const hasBurnedBurn = rewardPushesPenaltyBurn.some(
        (p) => p.dataTypeHash.toLowerCase() === key("REWARD_BURNED").toLowerCase()
      );

      if (STRICT_REWARD) {
        assertOk(hasBurnedBurn, "burn-path: missing RewardView.DataPushed(REWARD_BURNED) on applyLiquidationPenalty tx");
        assertOk(
          !hasPenaltyLedgerBurn,
          "burn-path: unexpected RewardView.DataPushed(REWARD_PENALTY_LEDGER_UPDATED) on applyLiquidationPenalty tx"
        );
      }

      out.steps.push({
        name: "applyLiquidationPenaltyBurn",
        txHash: rcPenaltyBurn.transactionHash,
        penaltyAmount: burnPenaltyAmount.toString(),
        easyBalanceBefore: balEasy2.toString(),
        easyBalanceAfter: balEasy3.toString(),
        penaltyDebtBefore: debt2Before.toString(),
        penaltyDebtAfter: debt2After.toString(),
        rewardPushTypes: rewardPushesPenaltyBurn.map((p) => p.dataTypeHash.toLowerCase()),
        expectLedgerPath: false,
      });
    } else {
      out.steps.push({
        name: "applyLiquidationPenaltyBurn",
        skipped: true,
        reason: "failed to mint enough Easy to borrower or quoted penalty was zero; cannot exercise burn-path",
      });
    }

    // 6) Degradation path: RewardView unavailable must not block default guarantee -> reward penalty.
    //    The reward ledger result is authoritative immediately; RewardView failure markers may lag until the
    //    cached REWARD_VIEW address rolls over, at which point backend retry/read-model repair becomes observable.
    const borrowIntent2 = {
      ...borrowIntent,
      expireAt: (await latestBlockNumber()) + ONE_HOUR_BLOCKS,
      salt: ethers.keccak256(ethers.toUtf8Bytes(`liq-reward-borrow-degrade-${Date.now()}`)),
    };
    const lendIntent2 = {
      ...lendIntent,
      expireAt: borrowIntent2.expireAt,
      salt: ethers.keccak256(ethers.toUtf8Bytes(`liq-reward-lend-degrade-${Date.now()}`)),
    };
    const lendHash2 = buildLendIntentHash(lendIntent2);
    const sigBorrow2 = await borrower.signTypedData(domain, typesBorrow, borrowIntent2);
    const sigLend2 = await lender.signTypedData(domain, typesLend, lendIntent2);

    await waitTx(usdc.connect(lender).approve(vblAddr, principal), "approve reserve degrade");
    await waitTx(vbl.connect(lender).reserveForLending(lender.address, settlementTokenAddr, principal, lendHash2), "reserve degrade");
    const collateralBeforeDegrade = (await cm.getCollateral(borrower.address, settlementTokenAddr)) as bigint;
    const collateralTopUpDegrade = collateralBeforeDegrade < collateral ? collateral - collateralBeforeDegrade : 0n;
    if (collateralTopUpDegrade > 0n) {
      await waitTx(usdc.connect(borrower).approve(cmAddr, collateralTopUpDegrade), "approve collateral degrade");
      await waitTx(vaultCore.connect(borrower).deposit(settlementTokenAddr, collateralTopUpDegrade), "deposit collateral degrade");
    }
    await waitTx(usdc.connect(borrower).approve(vaultCoreAddr, collateral), "approve collateral degrade");
    const rcMatchDegrade = await waitTx(
      vbl.connect(borrower).finalizeMatch(borrowIntent2, [lendIntent2], sigBorrow2, [sigLend2]),
      "finalizeMatch degrade"
    );

    const orderId2 = extractOrderIdFromReceipt(rcMatchDegrade, orderEngine, orderEngineAddr);
    assertOk(orderId2 !== null, "LoanOrderCreated not found for degrade order");
    const ord2 = (await orderEngine.getLoanOrderForView(orderId2)) as any;
    await mineToBlock(BigInt(ord2.maturity) + 1n);
    try {
      const bn = await ethers.provider.getBlockNumber();
        const settlementTokenDecimals = Number(await usdc.decimals().catch(() => 6));
      await waitTx(
          po.connect(deployer).updatePrice(settlementTokenAddr, ethers.parseUnits("1", settlementTokenDecimals), bn),
        "refreshPrice degrade"
      );
    } catch {
      // best-effort
    }

    const rewardViewModuleBefore = rewardViewAddr;
    const unavailableRewardView = await deployUnavailableRewardView();
    await waitTx(
      registry.connect(deployer).setModule(key("REWARD_VIEW"), unavailableRewardView),
      "replace RewardView with unavailable mock"
    );
    try {
      const penaltyBeforeImmediate = (await rewardAccrualManager.getPenaltyDebt(borrower.address)) as bigint;
      const rcLiqImmediate = await waitTx(
        settlementManager.connect(deployer).settleOrLiquidate(orderId2),
        "settleOrLiquidate rewardview-unavailable immediate"
      );
      const penaltyAfterImmediate = (await rewardAccrualManager.getPenaltyDebt(borrower.address)) as bigint;
      assertOk(
        penaltyAfterImmediate >= penaltyBeforeImmediate,
        "rewardview-unavailable immediate liquidation should not decrease penalty debt unexpectedly"
      );

      const immediateFailedPenaltyPushes = extractRewardViewPushFailed(rcLiqImmediate, rewardAccrualManagerAddr).filter(
        (entry) => entry.op === key("PENALTY_LEDGER").toLowerCase()
      );

      out.steps.push({
        name: "liquidate_rewardview_unavailable_immediate",
        txHash: rcLiqImmediate.transactionHash,
        unavailableRewardView,
        penaltyDebtBefore: penaltyBeforeImmediate.toString(),
        penaltyDebtAfter: penaltyAfterImmediate.toString(),
        rewardViewPushFailedCount: immediateFailedPenaltyPushes.length,
        expectedBehavior:
          "main path and ledger must succeed immediately; missing failure marker before cache rollover is acceptable and should be repaired by backend reconciliation",
      });

      await advanceBlocks(1_801n);

      await ethers.provider.send("hardhat_impersonateAccount", [rewardManagerCoreAddr]);
      await ethers.provider.send("hardhat_setBalance", [rewardManagerCoreAddr, "0x56BC75E2D63100000"]);
      const rewardManagerCoreSigner = await ethers.getSigner(rewardManagerCoreAddr);

      const explicitPenaltyUser = ethers.Wallet.createRandom().address;
      const explicitSeededDebt = 25n;
      const explicitOffsetAmount = 10n;
      const explicitExpectedRemaining = explicitSeededDebt - explicitOffsetAmount;

      await waitTx(
        rewardAccrualManager
          .connect(rewardManagerCoreSigner)
          .applyLateRepayPenalty(explicitPenaltyUser, explicitSeededDebt, rewardManagerCoreAddr),
        "seed explicit post-cache penalty debt"
      );

      const rcExplicitPenaltyOffset = await waitTx(
        rewardAccrualManager
          .connect(rewardManagerCoreSigner)
          .offsetPenaltyOnReward(explicitPenaltyUser, explicitOffsetAmount, "reward-view-cache-rolled-liquidation-explicit"),
        "offsetPenaltyOnReward rewardview-unavailable post-cache explicit"
      );

      const explicitFailedPenaltyPushes = extractRewardViewPushFailed(
        rcExplicitPenaltyOffset,
        rewardAccrualManagerAddr
      ).filter((entry) => entry.op === key("PENALTY_LEDGER").toLowerCase());
      assertOk(
        explicitFailedPenaltyPushes.length > 0,
        "missing RewardViewPushFailed(PENALTY_LEDGER) for explicit post-cache penalty offset"
      );
      const explicitLastFailureReason =
        explicitFailedPenaltyPushes[explicitFailedPenaltyPushes.length - 1].reason;
      assertOk(
        explicitLastFailureReason === REWARD_VIEW_UNAVAILABLE_REASON_HEX,
        "unexpected RewardViewPushFailed.reason for explicit post-cache penalty offset"
      );

      const explicitRemainingPenaltyDebt = (await rewardAccrualManager.getPenaltyDebt(explicitPenaltyUser)) as bigint;
      assertOk(
        explicitRemainingPenaltyDebt === explicitExpectedRemaining,
        "explicit post-cache penalty offset produced unexpected penalty debt"
      );

      out.steps.push({
        name: "rewardview_unavailable_explicit_penalty_offset_post_cache",
        txHash: rcExplicitPenaltyOffset.transactionHash,
        unavailableRewardView,
        user: explicitPenaltyUser,
        penaltyDebtBefore: explicitSeededDebt.toString(),
        penaltyDebtAfter: explicitRemainingPenaltyDebt.toString(),
        rewardViewPushFailedCount: explicitFailedPenaltyPushes.length,
        lastFailureReason: explicitLastFailureReason,
        coverageStatus: "covered",
        semantics:
          "explicit penalty-ledger mutation under unavailable RewardView after cache rollover; this is the authoritative coverage for backend replay and report classification",
      });

      const borrowIntent3 = {
        ...borrowIntent,
        expireAt: (await latestBlockNumber()) + ONE_HOUR_BLOCKS,
        salt: ethers.keccak256(ethers.toUtf8Bytes(`liq-reward-borrow-degrade-post-cache-${Date.now()}`)),
      };
      const lendIntent3 = {
        ...lendIntent,
        expireAt: borrowIntent3.expireAt,
        salt: ethers.keccak256(ethers.toUtf8Bytes(`liq-reward-lend-degrade-post-cache-${Date.now()}`)),
      };
      const lendHash3 = buildLendIntentHash(lendIntent3);
      const sigBorrow3 = await borrower.signTypedData(domain, typesBorrow, borrowIntent3);
      const sigLend3 = await lender.signTypedData(domain, typesLend, lendIntent3);

      await waitTx(usdc.connect(lender).approve(vblAddr, principal), "approve reserve degrade post-cache");
      await waitTx(vbl.connect(lender).reserveForLending(lender.address, settlementTokenAddr, principal, lendHash3), "reserve degrade post-cache");
      const collateralBeforeDegradePostCache = (await cm.getCollateral(borrower.address, settlementTokenAddr)) as bigint;
      const collateralTopUpDegradePostCache =
        collateralBeforeDegradePostCache < collateral ? collateral - collateralBeforeDegradePostCache : 0n;
      if (collateralTopUpDegradePostCache > 0n) {
        await waitTx(
          usdc.connect(borrower).approve(cmAddr, collateralTopUpDegradePostCache),
          "approve collateral deposit degrade post-cache"
        );
        await waitTx(
          vaultCore.connect(borrower).deposit(settlementTokenAddr, collateralTopUpDegradePostCache),
          "deposit collateral degrade post-cache"
        );
      }
      await waitTx(usdc.connect(borrower).approve(vaultCoreAddr, collateral), "approve collateral degrade post-cache");
      const rcMatchDegradePostCache = await waitTx(
        vbl.connect(borrower).finalizeMatch(borrowIntent3, [lendIntent3], sigBorrow3, [sigLend3]),
        "finalizeMatch degrade post-cache"
      );

      const orderId3 = extractOrderIdFromReceipt(rcMatchDegradePostCache, orderEngine, orderEngineAddr);
      assertOk(orderId3 !== null, "LoanOrderCreated not found for degrade post-cache order");
      const ord3 = (await orderEngine.getLoanOrderForView(orderId3)) as any;
      await mineToBlock(BigInt(ord3.maturity) + 1n);
      try {
        const bn = await ethers.provider.getBlockNumber();
        const settlementTokenDecimals = Number(await usdc.decimals().catch(() => 6));
        await waitTx(
          po.connect(deployer).updatePrice(settlementTokenAddr, ethers.parseUnits("1", settlementTokenDecimals), bn),
          "refreshPrice degrade post-cache"
        );
      } catch {
        // best-effort
      }

      const penaltyBeforeDegrade = (await rewardAccrualManager.getPenaltyDebt(borrower.address)) as bigint;
      const rcLiqDegrade = await waitTx(
        settlementManager.connect(deployer).settleOrLiquidate(orderId3),
        "settleOrLiquidate rewardview-unavailable post-cache"
      );
      const penaltyAfterDegrade = (await rewardAccrualManager.getPenaltyDebt(borrower.address)) as bigint;
      assertOk(
        penaltyAfterDegrade >= penaltyBeforeDegrade,
        "rewardview-unavailable post-cache liquidation should not decrease penalty debt unexpectedly"
      );

      const failedPenaltyPushes = extractRewardViewPushFailed(rcLiqDegrade, rewardAccrualManagerAddr).filter(
        (entry) => entry.op === key("PENALTY_LEDGER").toLowerCase()
      );

      const penaltyLedgerChanged = penaltyAfterDegrade > penaltyBeforeDegrade;
      if (penaltyLedgerChanged) {
        assertOk(
          failedPenaltyPushes.length > 0,
          "missing RewardViewPushFailed(PENALTY_LEDGER) when RewardView is unavailable after cache rollover"
        );
        assertOk(
          failedPenaltyPushes[failedPenaltyPushes.length - 1].reason === REWARD_VIEW_UNAVAILABLE_REASON_HEX,
          "unexpected RewardViewPushFailed.reason for unavailable RewardView"
        );
      }

      out.steps.push({
        name: "liquidate_rewardview_unavailable_post_cache",
        txHash: rcLiqDegrade.transactionHash,
        unavailableRewardView,
        penaltyDebtBefore: penaltyBeforeDegrade.toString(),
        penaltyDebtAfter: penaltyAfterDegrade.toString(),
        penaltyLedgerChanged,
        rewardViewPushFailedCount: failedPenaltyPushes.length,
        lastFailureReason:
          failedPenaltyPushes.length > 0 ? failedPenaltyPushes[failedPenaltyPushes.length - 1].reason : null,
        coverageStatus: penaltyLedgerChanged ? "covered" : "warning",
        warning:
          penaltyLedgerChanged
            ? null
            : "liquidation path stayed functionally green but did not mutate the penalty ledger; explicit post-cache offset step is the authoritative coverage and this observation must not be treated as clean-green coverage",
        rewardViewCacheDelayBlocks: ONE_HOUR_BLOCKS.toString(),
      });
    } finally {
      try {
        await ethers.provider.send("hardhat_stopImpersonatingAccount", [rewardManagerCoreAddr]);
      } catch {
        // best-effort
      }
      await waitTx(
        registry.connect(deployer).setModule(key("REWARD_VIEW"), rewardViewModuleBefore),
        "restore RewardView module"
      );
      await advanceRewardViewCacheTtl();
    }

    const file = artifacts.writeJson(`liquidation-reward-penalty.${Date.now()}.json`, out);
    console.log(`[E2E] wrote artifacts: ${file}`);
  } catch (e: any) {
    out.error = fmtErr(e);
    const file = artifacts.writeJson(`liquidation-reward-penalty.FAIL.${Date.now()}.json`, out);
    console.error(`[E2E] failed; wrote artifacts: ${file}`);
    throw e;
  } finally {
    await network.provider.send("evm_revert", [snap]);
  }
}

async function main() {
  await runLiquidationRewardPenalty();
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const _isMain = typeof require !== "undefined" && require.main === module;
if (_isMain) {
  main().catch((e) => {
    console.error("\n❌ e2e-localhost-liquidation-reward-penalty FAILED\n");
    console.error(e);
    process.exit(1);
  });
}
