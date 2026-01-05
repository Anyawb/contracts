import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";
import { scanViewModules } from "./utils/view-scan";

const ONE_HOUR = 60n * 60n;
const ONE_DAY = 24n * ONE_HOUR;

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function calcTotalDue(principal: bigint, rateBps: bigint, termSec: bigint) {
  const denom = 365n * ONE_DAY * 10_000n;
  const interest = (principal * rateBps * termSec) / denom;
  return principal + interest;
}

async function evmIncreaseTime(seconds: bigint) {
  await ethers.provider.send("evm_increaseTime", [Number(seconds)]);
  await ethers.provider.send("evm_mine", []);
}

type RewardSnapshot = {
  balance: bigint;
  totalEarned: bigint;
  totalBurned: bigint;
  penaltyDebt: bigint;
};

type DataPushed = { typeHash: string; payload: string };

function parseRewardDataPushed(receipt: any, rewardViewAddr: string): DataPushed[] {
  const iface = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
  const out: DataPushed[] = [];
  for (const log of receipt.logs) {
    if (!log?.address) continue;
    if (log.address.toLowerCase() !== rewardViewAddr.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "DataPushed") {
        out.push({ typeHash: parsed.args.dataTypeHash as string, payload: parsed.args.payload as string });
      }
    } catch {
      // ignore
    }
  }
  return out;
}

export async function runRewardEdgecases() {
  // fail fast if node is not reachable
  await ethers.provider.getBlockNumber();

  const signers = await ethers.getSigners();
  if (signers.length < 15) throw new Error(`Need at least 15 signers (have ${signers.length})`);

  const deployer = signers[0];
  const borrower = signers[11];
  const lenderA = signers[12];
  const lenderB = signers[13];

  console.log("=== E2E Reward Edge Cases (localhost) ===\n");
  console.log("Covers (Architecture-Guide aligned):");
  console.log("- 落账后触发：LendingEngine -> RewardManager -> RewardManagerCore -> RewardView(DataPushed)");
  console.log("- partial repay 不应触发奖励/扣罚（避免误清锁定）");
  console.log("- early full / on-time full / late full 三种 outcome");
  console.log("- late full: 余额不足 => penaltyLedger；余额充足 => burn");
  console.log("- 多订单同 borrower：按订单独立锁定与结算（避免 maturity 覆盖错判）\n");

  const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
  const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;
  const aw = (await ethers.getContractAt("AssetWhitelist", CONTRACT_ADDRESSES.AssetWhitelist)) as any;
  const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", CONTRACT_ADDRESSES.PriceOracle)) as any;
  const feeRouter = (await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", CONTRACT_ADDRESSES.FeeRouter)) as any;
  const usdc = (await ethers.getContractAt("MockERC20", CONTRACT_ADDRESSES.MockUSDC)) as any;
  const vaultCore = (await ethers.getContractAt("VaultCore", CONTRACT_ADDRESSES.VaultCore)) as any;
  const vbl = (await ethers.getContractAt("VaultBusinessLogic", CONTRACT_ADDRESSES.VaultBusinessLogic)) as any;

  const rewardView = (await ethers.getContractAt("RewardView", CONTRACT_ADDRESSES.RewardView)) as any;
  const rewardPoints = (await ethers.getContractAt("src/Token/RewardPoints.sol:RewardPoints", CONTRACT_ADDRESSES.RewardPoints)) as any;

  const orderEngineAddr = await registry.getModuleOrRevert(key("ORDER_ENGINE"));
  const orderEngine = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", orderEngineAddr)) as any;
  const cm = (await ethers.getContractAt("CollateralManager", CONTRACT_ADDRESSES.CollateralManager)) as any;
  const vle = await ethers.getContractAt(
    "src/Vault/modules/VaultLendingEngine.sol:VaultLendingEngine",
    CONTRACT_ADDRESSES.VaultLendingEngine
  );

  const rewardDecimals = (await rewardPoints.decimals()) as number;
  const ONE_POINT = 10n ** BigInt(rewardDecimals);
  const PENALTY = (ONE_POINT * 500n) / 10_000n; // latePenaltyBps=500
  const fmtPoints = (x: bigint) => ethers.formatUnits(x, rewardDecimals);

  const DATA_TYPE_REWARD_EARNED = ethers.keccak256(ethers.toUtf8Bytes("REWARD_EARNED"));
  const DATA_TYPE_REWARD_BURNED = ethers.keccak256(ethers.toUtf8Bytes("REWARD_BURNED"));
  const DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED = ethers.keccak256(ethers.toUtf8Bytes("REWARD_PENALTY_LEDGER_UPDATED"));

  // ============ ViewScan (best-effort) ============
  await scanViewModules(CONTRACT_ADDRESSES.Registry, { assetAddr: usdc.target as string, sampleUser: borrower.address });

  // ============ Preflight: VaultCore must trust ORDER_ENGINE as business module ============
  // ORDER_ENGINE.repay() 会调用 VaultCore.repayFor(...) 做账本同步；如果 VaultCore.registryAddrVar 指向错误的 Registry（或 Registry 未绑定 ORDER_ENGINE），会导致回滚。
  {
    const coreRegistry = (await vaultCore.registryAddrVar()) as string;
    if (coreRegistry.toLowerCase() !== CONTRACT_ADDRESSES.Registry.toLowerCase()) {
      throw new Error(
        `VaultCore.registryAddrVar mismatch: got=${coreRegistry} expect=${CONTRACT_ADDRESSES.Registry}. ` +
          `Please re-run 'npm run deploy:localhost' to ensure modules are wired correctly.`
      );
    }
    const oe = (await registry.getModule(key("ORDER_ENGINE"))) as string;
    if (oe === ethers.ZeroAddress || oe.toLowerCase() !== (orderEngineAddr as string).toLowerCase()) {
      throw new Error(
        `Registry.ORDER_ENGINE mismatch: got=${oe} expect=${orderEngineAddr}. ` +
          `Please re-run 'npm run deploy:localhost' to refresh localhost.json + contracts-localhost.ts.`
      );
    }
    const vc = (await registry.getModule(key("VAULT_CORE"))) as string;
    if (vc === ethers.ZeroAddress || vc.toLowerCase() !== CONTRACT_ADDRESSES.VaultCore.toLowerCase()) {
      throw new Error(
        `Registry.VAULT_CORE mismatch: got=${vc} expect=${CONTRACT_ADDRESSES.VaultCore}. ` +
          `Please re-run 'npm run deploy:localhost'.`
      );
    }
  }

  // ============ Sanity: ensure Registry has KEY_REWARD_MANAGER_CORE bound ============
  // RewardView.getUserPenaltyDebt 透传 RMCore，需要 Registry 正确设置该 module key；若旧部署缺失，这里在本地链做 best-effort 补齐。
  try {
    const k = key("REWARD_MANAGER_CORE");
    const existing = (await registry.getModule(k)) as string;
    if (existing === ethers.ZeroAddress) {
      await (await registry.connect(deployer).setModule(k, CONTRACT_ADDRESSES.RewardManagerCore)).wait();
      console.log(`↪️ Bound missing REWARD_MANAGER_CORE -> ${CONTRACT_ADDRESSES.RewardManagerCore}`);
    }
  } catch (e: any) {
    const msg = e?.shortMessage ?? e?.message ?? String(e);
    console.log(`⚠️ Could not ensure Registry.REWARD_MANAGER_CORE binding (will fallback to cached pendingPenalty): ${msg}`);
  }

  // ============ Sanity: ensure ORDER_ENGINE and VAULT_CORE bindings (required for orderEngine.repay -> VaultCore.repayFor) ============
  // 如果 Registry 漂移（旧部署残留/手工 setModule），ORDER_ENGINE 的 repay 会在 VaultCore.onlyBusinessModule 里被拒绝。
  async function ensureModuleBinding(keyUpper: string, expectedAddr: string) {
    const k = key(keyUpper);
    const existing = (await registry.getModule(k)) as string;
    if (existing === ethers.ZeroAddress || existing.toLowerCase() !== expectedAddr.toLowerCase()) {
      try {
        await (await registry.connect(deployer).setModule(k, expectedAddr)).wait();
        console.log(`↪️ Bound ${keyUpper} -> ${expectedAddr} (was ${existing})`);
      } catch (e: any) {
        const msg = e?.shortMessage ?? e?.message ?? String(e);
        console.log(`⚠️ Failed to bind ${keyUpper} -> ${expectedAddr}: ${msg}`);
      }
    }
  }
  await ensureModuleBinding("ORDER_ENGINE", orderEngineAddr as string);
  await ensureModuleBinding("VAULT_CORE", CONTRACT_ADDRESSES.VaultCore);

  // ============ Roles ============
  const ensureRole = async (roleName: string, who: string | any) => {
    const whoAddr = await ethers.resolveAddress(who);
    const role = key(roleName);
    if (!(await acm.hasRole(role, whoAddr))) {
      await (await acm.grantRole(role, whoAddr)).wait();
    }
  };

  await ensureRole("ADD_WHITELIST", deployer.address);
  await ensureRole("UPDATE_PRICE", deployer.address);
  await ensureRole("SET_PARAMETER", deployer.address);

  // ORDER_ENGINE permissions
  await ensureRole("BORROW", orderEngineAddr);
  await ensureRole("DEPOSIT", orderEngineAddr);

  // match orchestration
  await ensureRole("ORDER_CREATE", CONTRACT_ADDRESSES.VaultBusinessLogic);
  await ensureRole("DEPOSIT", CONTRACT_ADDRESSES.VaultBusinessLogic);

  // borrower needs repay permission on ORDER_ENGINE
  await ensureRole("REPAY", borrower.address);

  // asset/price setup
  const assetAddr = usdc.target as string;
  if (!(await aw.isAssetAllowed(assetAddr))) await (await aw.connect(deployer).addAllowedAsset(assetAddr)).wait();
  {
    const cfg = await po.getAssetConfig(assetAddr);
    if (!cfg.isActive) await (await po.connect(deployer).configureAsset(assetAddr, "usd-coin", 8, 3600)).wait();
  }
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  await (await po.connect(deployer).updatePrice(assetAddr, ethers.parseUnits("1", 6), now)).wait();
  if (!(await feeRouter.isTokenSupported(assetAddr))) await (await feeRouter.connect(deployer).addSupportedToken(assetAddr)).wait();

  // fund users
  await (await usdc.connect(deployer).transfer(borrower.address, ethers.parseUnits("50000", 6))).wait();
  await (await usdc.connect(deployer).transfer(lenderA.address, ethers.parseUnits("50000", 6))).wait();
  await (await usdc.connect(deployer).transfer(lenderB.address, ethers.parseUnits("50000", 6))).wait();

  // Ensure borrower has enough collateral in ledger for multiple borrows
  // (matchflow path requires collateral manager updates via VaultCore.deposit)
  const collateralAmt = ethers.parseUnits("5000", 6);
  if ((await cm.getCollateral(borrower.address, assetAddr)) < collateralAmt) {
    await (await usdc.connect(borrower).approve(CONTRACT_ADDRESSES.VaultCore, collateralAmt)).wait();
    await (await vaultCore.connect(borrower).deposit(assetAddr, collateralAmt)).wait();
  }

  // EIP-712 domain/types for matchflow (aligned with existing batch e2e scripts)
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

  function buildLendIntentHash(li: any) {
    const typeHash = ethers.keccak256(
      ethers.toUtf8Bytes(
        "LendIntent(address lender,address asset,uint256 amount,uint16 minTermDays,uint16 maxTermDays,uint256 minRateBps,uint256 expireAt,bytes32 salt)"
      )
    );
    const coder = ethers.AbiCoder.defaultAbiCoder();
    return ethers.keccak256(
      coder.encode(
        ["bytes32", "address", "address", "uint256", "uint16", "uint16", "uint256", "uint256", "bytes32"],
        [typeHash, li.lender, li.asset, li.amount, li.minTermDays, li.maxTermDays, li.minRateBps, li.expireAt, li.salt]
      )
    );
  }

  const typesLend = {
    LendIntent: [
      { name: "lender", type: "address" },
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "minTermDays", type: "uint16" },
      { name: "maxTermDays", type: "uint16" },
      { name: "minRateBps", type: "uint256" },
      { name: "expireAt", type: "uint256" },
      { name: "salt", type: "bytes32" },
    ],
  };

  const readSnapshot = async (label: string): Promise<RewardSnapshot> => {
    const balance = (await rewardPoints.balanceOf(borrower.address)) as bigint;
    const summary = await rewardView.connect(borrower).getUserRewardSummary(borrower.address);
    const totalEarned = summary[0] as bigint;
    const totalBurned = summary[1] as bigint;
    // penaltyDebt 权威读取应来自 RewardView.getUserPenaltyDebt（透传 RMCore）；若旧部署缺 module key 或 read-gate 配置异常，则回退到缓存字段 summary.pendingPenalty
    let penaltyDebt: bigint;
    try {
      penaltyDebt = (await rewardView.connect(borrower).getUserPenaltyDebt(borrower.address)) as bigint;
    } catch {
      penaltyDebt = summary[2] as bigint;
    }
    console.log(
      `  [${label}] bal=${fmtPoints(balance)} earned=${fmtPoints(totalEarned)} burned=${fmtPoints(totalBurned)} penaltyDebt=${fmtPoints(penaltyDebt)}`
    );
    return { balance, totalEarned, totalBurned, penaltyDebt };
  };

  async function createOrder(params: { lender: any; termDays: bigint; principal: bigint; rateBps: bigint; tag: string }): Promise<bigint> {
    const expireAt = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);
    const borrowIntent = {
      borrower: borrower.address,
      collateralAsset: assetAddr,
      collateralAmount: ethers.parseUnits("1000", 6),
      borrowAsset: assetAddr,
      amount: params.principal,
      termDays: Number(params.termDays),
      rateBps: params.rateBps,
      expireAt,
      salt: ethers.keccak256(ethers.toUtf8Bytes(`borrow-${params.tag}-${Date.now()}`)),
    };

    const lendIntent = {
      lender: params.lender.address,
      asset: assetAddr,
      amount: params.principal,
      minTermDays: 1,
      maxTermDays: 360,
      minRateBps: 0n,
      expireAt,
      salt: ethers.keccak256(ethers.toUtf8Bytes(`lend-${params.tag}-${Date.now()}`)),
    };

    await (await usdc.connect(params.lender).approve(CONTRACT_ADDRESSES.VaultBusinessLogic, params.principal)).wait();
    const lendHash = buildLendIntentHash(lendIntent);
    await (await vbl.connect(params.lender).reserveForLending(params.lender.address, assetAddr, params.principal, lendHash)).wait();

    const sigBorrower = await borrower.signTypedData(domain, typesBorrow as any, borrowIntent as any);
    const sigLender = await params.lender.signTypedData(domain, typesLend as any, lendIntent as any);

    const tx = await vbl.connect(deployer).finalizeMatch(borrowIntent, [lendIntent], sigBorrower, [sigLender]);
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

    // Borrower needs USDC to repay; keep a buffer
    // borrower needs USDC to repay (matchflow may transfer principal; ensure buffer anyway)
    await (await usdc.connect(deployer).transfer(borrower.address, ethers.parseUnits("5000", 6))).wait();
    return orderId;
  }

  async function getOrderForView(orderId: bigint) {
    // _getLoanOrderForView requires VIEW_SYSTEM_DATA; deploylocal grants it to deployer.
    return (await orderEngine.connect(deployer)._getLoanOrderForView(orderId)) as any;
  }

  async function getTotalDueFromChain(orderId: bigint): Promise<bigint> {
    const ord = await getOrderForView(orderId);
    const principal = ord.principal as bigint;
    const rate = ord.rate as bigint;
    const term = ord.term as bigint; // seconds
    const denom = 365n * ONE_DAY * 10_000n;
    const interest = (principal * rate * term) / denom;
    return principal + interest;
  }

  async function repay(orderId: bigint, amount: bigint) {
    await (await usdc.connect(borrower).approve(orderEngineAddr, amount)).wait();
    return await (await orderEngine.connect(borrower).repay(orderId, amount)).wait();
  }

  // ========= Scenario 1: partial repay MUST NOT trigger reward =========
  console.log("=== 1) Partial repay: must not trigger any RewardView DataPushed ===");
  {
    const principal = ethers.parseUnits("1200", 6); // >= MIN_ELIGIBLE_PRINCIPAL(1000)
    const rateBps = 1000n;
    const termDays = 5n;

    const s0 = await readSnapshot("before partial");
    const orderId = await createOrder({ lender: lenderA, termDays, principal, rateBps, tag: "partial" });
    const totalDue = await getTotalDueFromChain(orderId);
    const partial = totalDue / 2n;
    {
      const ord0 = await getOrderForView(orderId);
      console.log(
        `  [debug] orderId=${orderId.toString()} principal=${ord0.principal?.toString?.() ?? "?"} rate=${ord0.rate?.toString?.() ?? "?"} term=${ord0.term?.toString?.() ?? "?"} maturity=${ord0.maturity?.toString?.() ?? "?"} repaid=${ord0.repaidAmount?.toString?.() ?? "?"}`
      );
      console.log(`  [debug] totalDue=${totalDue.toString()} partial=${partial.toString()}`);
    }
    const receipt = await repay(orderId, partial);

    const pushed = parseRewardDataPushed(receipt, rewardView.target as string);
    if (pushed.length !== 0) {
      // extra debug to understand why a partial repay emitted reward events
      try {
        const ord1 = await getOrderForView(orderId);
        const isFullyRepaid = (ord1.repaidAmount as bigint) >= totalDue;
        console.log(
          `  [debug] after repay: repaid=${ord1.repaidAmount?.toString?.() ?? "?"} isFullyRepaid=${isFullyRepaid}`
        );
      } catch {}
      const names: Record<string, string> = {
        [DATA_TYPE_REWARD_EARNED.toLowerCase()]: "REWARD_EARNED",
        [DATA_TYPE_REWARD_BURNED.toLowerCase()]: "REWARD_BURNED",
        [DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED.toLowerCase()]: "REWARD_PENALTY_LEDGER_UPDATED",
        [ethers.keccak256(ethers.toUtf8Bytes("REWARD_LEVEL_UPDATED")).toLowerCase()]: "REWARD_LEVEL_UPDATED",
        [ethers.keccak256(ethers.toUtf8Bytes("REWARD_PRIVILEGE_UPDATED")).toLowerCase()]: "REWARD_PRIVILEGE_UPDATED",
        [ethers.keccak256(ethers.toUtf8Bytes("REWARD_STATS_UPDATED")).toLowerCase()]: "REWARD_STATS_UPDATED",
      };
      const detail = pushed
        .map((p) => `${names[p.typeHash.toLowerCase()] ?? p.typeHash}(payloadLen=${(p.payload.length - 2) / 2})`)
        .join(", ");
      const earned = pushed.find((p) => p.typeHash.toLowerCase() === DATA_TYPE_REWARD_EARNED.toLowerCase());
      if (earned) {
        try {
          const coder = ethers.AbiCoder.defaultAbiCoder();
          const [u, amt, reason, ts] = coder.decode(
            ["address", "uint256", "string", "uint256"],
            earned.payload
          ) as unknown as [string, bigint, string, bigint];
          console.log(`  [debug] REWARD_EARNED decoded: user=${u} amount=${amt.toString()} reason=${reason} ts=${ts.toString()}`);
        } catch {}
      }
      throw new Error(`partial repay should not emit RewardView.DataPushed, got ${pushed.length}: ${detail}`);
    }
    const s1 = await readSnapshot("after partial");
    if (s1.balance !== s0.balance || s1.totalEarned !== s0.totalEarned || s1.totalBurned !== s0.totalBurned || s1.penaltyDebt !== s0.penaltyDebt) {
      throw new Error("partial repay changed reward state unexpectedly");
    }
    console.log("  ✅ OK\n");
  }

  // ========= Scenario 2: early full repay => no mint/no penalty =========
  console.log("=== 2) Early full repay: +0 point, no penalty ===");
  {
    const principal = ethers.parseUnits("1200", 6); // >= MIN_ELIGIBLE_PRINCIPAL(1000)
    const rateBps = 1000n;
    const termDays = 30n; // ensure early: now + window < maturity

    const s0 = await readSnapshot("before early");
    const orderId = await createOrder({ lender: lenderA, termDays, principal, rateBps, tag: "early" });
    const totalDue = await getTotalDueFromChain(orderId);
    const receipt = await repay(orderId, totalDue);

    const pushed = parseRewardDataPushed(receipt, rewardView.target as string);
    if (pushed.length !== 0) {
      // early full repay should NOT emit reward events
      throw new Error(`early full repay should not emit RewardView.DataPushed, got ${pushed.length}`);
    }
    const s1 = await readSnapshot("after early");
    if (s1.balance !== s0.balance) throw new Error("early full repay minted points unexpectedly");
    if (s1.penaltyDebt !== s0.penaltyDebt) throw new Error("early full repay changed penaltyDebt unexpectedly");
    console.log("  ✅ OK\n");
  }

  // ========= Scenario 3: on-time full repay => mint 1 point and emit REWARD_EARNED =========
  console.log("=== 3) On-time full repay: +1 point and REWARD_EARNED DataPushed ===");
  {
    const principal = ethers.parseUnits("1200", 6); // >= MIN_ELIGIBLE_PRINCIPAL(1000)
    const rateBps = 1000n;
    const termDays = 5n;

    const s0 = await readSnapshot("before on-time");
    const orderId = await createOrder({ lender: lenderA, termDays, principal, rateBps, tag: "ontime" });
    const totalDue = await getTotalDueFromChain(orderId);

    // repay near maturity to be on-time (within window)
    {
      const ord = await getOrderForView(orderId);
      const nowTs = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
      const maturity = ord.maturity as bigint;
      if (maturity > nowTs + ONE_HOUR) {
        await evmIncreaseTime(maturity - nowTs - ONE_HOUR);
      }
    }
    const receipt = await repay(orderId, totalDue);
    const s1 = await readSnapshot("after on-time");

    if (s1.balance - s0.balance !== ONE_POINT) throw new Error(`expected +1 point, got ${fmtPoints(s1.balance - s0.balance)}`);
    const pushed = parseRewardDataPushed(receipt, rewardView.target as string);
    const earned = pushed.find((p) => p.typeHash.toLowerCase() === DATA_TYPE_REWARD_EARNED.toLowerCase());
    if (!earned) throw new Error("expected REWARD_EARNED DataPushed on on-time repay");

    // decode payload: (address user, uint256 amount, string reason, uint256 ts)
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const [u, amt] = coder.decode(
      ["address", "uint256", "string", "uint256"],
      earned.payload
    ) as unknown as [string, bigint, string, bigint];
    if (u.toLowerCase() !== borrower.address.toLowerCase()) throw new Error("REWARD_EARNED payload user mismatch");
    if (amt !== ONE_POINT) throw new Error(`REWARD_EARNED payload amount mismatch: ${amt.toString()}`);
    console.log("  ✅ OK\n");
  }

  // ========= Scenario 4: late full repay with ZERO points => penaltyLedger increases (no burn) =========
  console.log("=== 4) Late full repay (insufficient balance): penaltyLedger increases and emits REWARD_PENALTY_LEDGER_UPDATED ===");
  {
    // use a fresh borrower with zero points to make the condition deterministic
    const borrower2 = signers[14];
    await ensureRole("ORDER_CREATE", borrower2.address);
    await ensureRole("REPAY", borrower2.address);
    await (await usdc.connect(deployer).transfer(borrower2.address, ethers.parseUnits("50000", 6))).wait();

    const read2 = async (label: string) => {
      const bal = (await rewardPoints.balanceOf(borrower2.address)) as bigint;
      const penaltyDebt = (await rewardView.connect(borrower2).getUserPenaltyDebt(borrower2.address)) as bigint;
      console.log(`  [${label}] borrower2 bal=${fmtPoints(bal)} penaltyDebt=${fmtPoints(penaltyDebt)}`);
      return { bal, penaltyDebt };
    };

    // keep principal small to avoid borrowFor risk checks rejecting the match on some configs
    const principal = ethers.parseUnits("1200", 6); // >= MIN_ELIGIBLE_PRINCIPAL(1000)
    const rateBps = 1000n;
    const termDays = 5n; // ORDER_ENGINE allowed durations: 5/10/15/30/60/90/180/360 days
    const termSec = termDays * ONE_DAY;
    const totalDue = calcTotalDue(principal, rateBps, termSec);

    // borrower2 deposit collateral so matchflow can borrow
    // Over-collateralize to avoid config-dependent risk checks rejecting the borrow
    const depositAmt2 = ethers.parseUnits("20000", 6);
    await (await usdc.connect(borrower2).approve(CONTRACT_ADDRESSES.VaultCore, depositAmt2)).wait();
    await (await vaultCore.connect(borrower2).deposit(assetAddr, depositAmt2)).wait();

    const expireAt = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);
    const borrowIntent2 = {
      borrower: borrower2.address,
      collateralAsset: assetAddr,
      collateralAmount: ethers.parseUnits("10000", 6),
      borrowAsset: assetAddr,
      amount: principal,
      termDays: Number(termDays),
      rateBps,
      expireAt,
      salt: ethers.keccak256(ethers.toUtf8Bytes(`borrow-late-insufficient-${Date.now()}`)),
    };
    const lendIntent2 = {
      lender: lenderB.address,
      asset: assetAddr,
      amount: principal,
      minTermDays: 1,
      maxTermDays: 360,
      minRateBps: 0n,
      expireAt,
      salt: ethers.keccak256(ethers.toUtf8Bytes(`lend-late-insufficient-${Date.now()}`)),
    };
    await (await usdc.connect(lenderB).approve(CONTRACT_ADDRESSES.VaultBusinessLogic, principal)).wait();
    const lendHash2 = buildLendIntentHash(lendIntent2);
    await (await vbl.connect(lenderB).reserveForLending(lenderB.address, assetAddr, principal, lendHash2)).wait();
    const sigBorrower2 = await borrower2.signTypedData(domain, typesBorrow as any, borrowIntent2 as any);
    const sigLender2 = await lenderB.signTypedData(domain, typesLend as any, lendIntent2 as any);
    const tx2 = await vbl.connect(deployer).finalizeMatch(borrowIntent2, [lendIntent2], sigBorrower2, [sigLender2]);
    const receiptCreate2 = await tx2.wait();
    let orderId: bigint | null = null;
    for (const log of receiptCreate2!.logs) {
      try {
        const parsed = orderEngine.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === "LoanOrderCreated") { orderId = parsed.args.orderId as bigint; break; }
      } catch {}
    }
    if (orderId === null) throw new Error("LoanOrderCreated not found for borrower2");

    const b0 = await read2("before late repay");
    // jump beyond maturity + window to ensure late
    await evmIncreaseTime(termSec + 3n * ONE_DAY);

    await (await usdc.connect(borrower2).approve(orderEngineAddr, totalDue)).wait();
    const receipt = await (await orderEngine.connect(borrower2).repay(orderId, totalDue)).wait();

    const pushed = parseRewardDataPushed(receipt, rewardView.target as string);
    const pl = pushed.find((p) => p.typeHash.toLowerCase() === DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED.toLowerCase());
    if (!pl) throw new Error("expected REWARD_PENALTY_LEDGER_UPDATED DataPushed on late repay (insufficient balance)");

    const b1 = await read2("after late repay");
    if (b1.bal !== 0n) throw new Error("borrower2 should still have 0 points after late repay (insufficient balance)");
    if (b1.penaltyDebt - b0.penaltyDebt !== PENALTY) {
      throw new Error(`expected penaltyDebt delta == ${PENALTY.toString()} got ${(b1.penaltyDebt - b0.penaltyDebt).toString()}`);
    }
    console.log("  ✅ OK\n");
  }

  // ========= Scenario 5: multi-order independence (same borrower) =========
  console.log("=== 5) Multi-order independence: same borrower 2 orders with different outcomes ===");
  {
    const principal = ethers.parseUnits("1200", 6); // >= MIN_ELIGIBLE_PRINCIPAL(1000)
    const rateBps = 1000n;

    // Order A: on-time (10d)
    // Order B: late (5d) - should burn or ledger depending on balance; borrower currently has some balance, so likely burn.
    const before = await readSnapshot("before multi-order");
    const orderA = await createOrder({ lender: lenderA, termDays: 10n, principal, rateBps, tag: "multiA" });
    const orderB = await createOrder({ lender: lenderB, termDays: 5n, principal, rateBps, tag: "multiB" });

    // repay orderA on-time
    {
      const ordA = await getOrderForView(orderA);
      const nowTs = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
      const maturityA = ordA.maturity as bigint;
      if (maturityA > nowTs + ONE_HOUR) {
        await evmIncreaseTime(maturityA - nowTs - ONE_HOUR);
      }
    }
    const totalDueA = await getTotalDueFromChain(orderA);
    const rA = await repay(orderA, totalDueA);
    const pushedA = parseRewardDataPushed(rA, rewardView.target as string);
    if (!pushedA.some((p) => p.typeHash.toLowerCase() === DATA_TYPE_REWARD_EARNED.toLowerCase())) {
      throw new Error("expected REWARD_EARNED on orderA on-time repay");
    }

    // jump beyond orderB maturity + window to make it late
    {
      const ordB = await getOrderForView(orderB);
      const nowTs = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
      const maturityB = ordB.maturity as bigint;
      // go past maturity + ON_TIME_WINDOW (24h) comfortably
      const target = maturityB + 3n * ONE_DAY;
      if (target > nowTs) await evmIncreaseTime(target - nowTs);
    }
    const totalDueB = await getTotalDueFromChain(orderB);
    const rB = await repay(orderB, totalDueB);
    const pushedB = parseRewardDataPushed(rB, rewardView.target as string);
    if (!pushedB.some((p) => p.typeHash.toLowerCase() === DATA_TYPE_REWARD_BURNED.toLowerCase() || p.typeHash.toLowerCase() === DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED.toLowerCase())) {
      throw new Error("expected REWARD_BURNED or REWARD_PENALTY_LEDGER_UPDATED on orderB late repay");
    }

    const after = await readSnapshot("after multi-order");
    const earnedDelta = after.totalEarned - before.totalEarned;
    if (earnedDelta !== ONE_POINT) throw new Error(`multi-order: expected earned delta == 1 point, got ${fmtPoints(earnedDelta)}`);
    console.log("  ✅ OK\n");
  }

  console.log("✅ Reward edge cases E2E completed.\n");
}

// CLI entrypoint
// eslint-disable-next-line @typescript-eslint/no-var-requires
const _isMain = typeof require !== "undefined" && require.main === module;
if (_isMain) {
  runRewardEdgecases().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}


