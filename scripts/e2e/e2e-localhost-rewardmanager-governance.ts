import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost.ts";
import { runViewPreflight } from "./utils/view-preflight.ts";

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function assertOk(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function fmtErr(e: any) {
  return e?.shortMessage ?? e?.message ?? String(e);
}

function isMissingSelectorError(msg: string): boolean {
  return String(msg).includes("function selector was not recognized");
}

function errorSelector(sig: string): string {
  return ethers.id(sig).slice(0, 10);
}

function extractRevertData(e: any): string | undefined {
  const candidates: Array<unknown> = [
    e?.data,
    e?.error?.data,
    e?.error?.error?.data,
    e?.info?.error?.data,
    e?.info?.error?.error?.data,
    e?.receipt?.revertReason,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("0x")) return c;
  }
  const msg = fmtErr(e);
  const m = String(msg).match(/return data:\s*(0x[0-9a-fA-F]+)/);
  if (m?.[1]) return m[1];
  return undefined;
}

async function mustRevertWithSelector(
  label: string,
  fn: () => Promise<unknown>,
  expectedSel: string,
  opts: { allowNoData?: boolean } = {}
) {
  try {
    await fn();
  } catch (e: any) {
    const msg = fmtErr(e);
    if (isMissingSelectorError(String(msg))) {
      throw new Error(
        `[FAIL] ${label}: missing function selector on-chain (deployment/ABI mismatch). Re-run compile + deploy:localhost.`
      );
    }
    const data = extractRevertData(e);
    const sel = data && data.length >= 10 ? data.slice(0, 10).toLowerCase() : "";
    if (!sel && opts.allowNoData) {
      console.log(`  ✅ [revert no-data accepted] ${label}`);
      return;
    }
    assertOk(!!sel, `${label}: missing revert data (cannot validate selector)`);
    assertOk(sel === expectedSel.toLowerCase(), `${label}: unexpected error selector ${sel}, expected ${expectedSel}`);
    console.log(`  ✅ [revert selector ok] ${label}: ${sel}`);
    return;
  }
  throw new Error(`[FAIL] Expected revert, but succeeded: ${label}`);
}

async function waitTx<T extends { hash?: string; wait: () => Promise<any> }>(
  txPromise: Promise<T>,
  label?: string
): Promise<any> {
  const tx = await txPromise;
  const hash = tx?.hash ?? "unknown";
  const prefix = label ? `  ⛓️ tx ${label}` : "  ⛓️ tx";
  console.log(`${prefix}: ${hash}`);
  return await tx.wait();
}

async function snapshot(): Promise<string> {
  return await network.provider.send("evm_snapshot", []);
}

async function revertTo(id: string) {
  await network.provider.send("evm_revert", [id]);
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

const DATA_PUSH_IFACE = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
const DATA_PUSH_TOPIC0 = ethers.id("DataPushed(bytes32,bytes)").toLowerCase();

function extractDataPushTypes(receipt: any, emitter: string): string[] {
  return (receipt?.logs ?? [])
    .filter((log: any) => {
      if ((log?.topics?.[0] || "").toLowerCase() !== DATA_PUSH_TOPIC0) return false;
      return String(log.address ?? "").toLowerCase() === emitter.toLowerCase();
    })
    .map((log: any) => DATA_PUSH_IFACE.parseLog(log))
    .filter((parsed: any) => parsed)
    .map((parsed: any) => String(parsed.args.dataTypeHash).toLowerCase());
}

async function pickCleanUser(signers: any[], easyToken: any) {
  for (const s of signers) {
    const bal = (await easyToken.balanceOf(s.address)) as bigint;
    if (bal === 0n) return s;
  }
  return signers[0];
}

export async function runRewardManagerGovernance() {
  const snap = await snapshot();
  const artifacts = mkArtifactsWriter();
  try {
    const [deployer, user, outsider] = await ethers.getSigners();

    console.log("=== E2E RewardManager Governance (localhost) ===\n");

    await runViewPreflight({
      registryAddr: CONTRACT_ADDRESSES.Registry,
      acmAddr: CONTRACT_ADDRESSES.AccessControlManager,
      adminSigner: deployer,
      assetForPriceCheck: CONTRACT_ADDRESSES.MockUSDC,
    });

    const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
    const rmAddr = (await registry.getModuleOrRevert(key("REWARD_MANAGER"))) as string;
    const rvAddr = (await registry.getModuleOrRevert(key("REWARD_VIEW"))) as string;
    const gfmAddr = (await registry.getModuleOrRevert(key("GUARANTEE_FUND_MANAGER"))) as string;
    const easyTokenAddr = (await registry.getModuleOrRevert(key("EASY_TOKEN"))) as string;
    const easyEmissionConfigAddr = (await registry.getModule(key("EASY_EMISSION_CONFIG"))) as string;
    const easyStakingAddr = (await registry.getModule(key("EASY_STAKING"))) as string;

    const rm = (await ethers.getContractAt("RewardManager", rmAddr)) as any;
    const rv = (await ethers.getContractAt("RewardView", rvAddr)) as any;
    const easyToken = (await ethers.getContractAt("src/Token/EasyToken.sol:EasyToken", easyTokenAddr)) as any;

    if (easyEmissionConfigAddr && easyEmissionConfigAddr !== ethers.ZeroAddress) {
      const econf = (await ethers.getContractAt("EasyEmissionConfig", easyEmissionConfigAddr)) as any;
      const [thr, mintPer, kNum, kDen, valuationDecimals] = await econf.getEmissionParams();
      console.log(
        `  EasyEmissionConfig: thr=${thr.toString()} mintPer=${mintPer.toString()} valuationDecimals=${valuationDecimals.toString()} k=${kNum.toString()}/${kDen.toString()}`
      );
    } else {
      console.log("  ⚠️  EasyEmissionConfig not bound; skipping emission config read");
    }

    if (easyStakingAddr && easyStakingAddr !== ethers.ZeroAddress) {
      const staking = (await ethers.getContractAt("EasyStaking", easyStakingAddr)) as any;
      console.log(`  EasyStaking: totalSupply=${(await staking.totalSupply()).toString()}`);
    } else {
      console.log("  ⚠️  EasyStaking not bound; skipping staking read");
    }

    const missingRoleSel = errorSelector("MissingRole()");

    await mustRevertWithSelector(
      "onLoanEventByOrder from non-ORDER_ENGINE must revert",
      async () =>
        rm.connect(outsider).onLoanEventByOrder(user.address, 1n, ethers.parseUnits("1000", 6), 123n, 0),
      missingRoleSel,
      { allowNoData: true }
    );

    await mustRevertWithSelector(
      "applyLiquidationPenalty from non-GUARANTEE_FUND must revert",
      async () => rm.connect(outsider).applyLiquidationPenalty(user.address),
      missingRoleSel,
      { allowNoData: true }
    );

    await network.provider.send("hardhat_impersonateAccount", [gfmAddr]);
    await network.provider.send("hardhat_setBalance", [gfmAddr, "0x56BC75E2D63100000"]); // 100 ETH
    const gfmSigner = await ethers.getSigner(gfmAddr);

    const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;
    await network.provider.send("hardhat_impersonateAccount", [orderEngineAddr]);
    await network.provider.send("hardhat_setBalance", [orderEngineAddr, "0x56BC75E2D63100000"]); // 100 ETH
    const orderEngineSigner = await ethers.getSigner(orderEngineAddr);

    const signers = await ethers.getSigners();
    const target = await pickCleanUser(signers, easyToken);
    const orderId = BigInt(Date.now());
    const maturity = BigInt((await ethers.provider.getBlockNumber()) + 7_200);
    await waitTx(
      Promise.resolve(
        rm.connect(orderEngineSigner).onLoanEventByOrder(target.address, orderId, ethers.parseUnits("1000", 6), maturity, 0)
      ),
      "lock order for liquidation penalty"
    );

    const before = await rv.connect(target).getUserRewardSummaryWithMeta(target.address);
    const penaltyBefore = before[1] as bigint;
    const easyAmount = (await rm.quoteLiquidationPenalty(target.address)) as bigint;
    assertOk(easyAmount > 0n, "quoted liquidation penalty must be > 0");

    const tx = await rm.connect(gfmSigner).applyLiquidationPenalty(target.address);
    const receipt = await waitTx(Promise.resolve(tx), "applyLiquidationPenalty");
    const rewardPushTypes = extractDataPushTypes(receipt, rvAddr);

    const paIface = new ethers.Interface([
      "event PenaltyApplied(address indexed executor,address indexed user,uint256 easyAmount,uint256 blockNumber)",
    ]);
    const actionIface = new ethers.Interface([
      "event ActionExecuted(bytes32 indexed actionKey,string actionName,address indexed executor,uint256 blockNumber)",
    ]);
    const penaltyLog = receipt.logs.find((log: any) => {
      if (!log?.topics?.[0]) return false;
      return log.topics[0].toLowerCase() === paIface.getEvent("PenaltyApplied")!.topicHash.toLowerCase();
    });
    assertOk(!!penaltyLog, "PenaltyApplied event not found");

    const actionLog = receipt.logs.find((log: any) => {
      if (!log?.topics?.[0]) return false;
      return log.topics[0].toLowerCase() === actionIface.getEvent("ActionExecuted")!.topicHash.toLowerCase();
    });
    assertOk(!!actionLog, "ActionExecuted event not found");

    const after = await rv.connect(target).getUserRewardSummaryWithMeta(target.address);
    const penaltyAfter = after[1] as bigint;
    assertOk(penaltyAfter === penaltyBefore + easyAmount, "penalty ledger did not increase as expected");

    const artifactPath = artifacts.writeJson(`rewardmanager-governance.${Date.now()}.json`, {
      name: "RewardManager governance (localhost)",
      generatedAt: new Date().toISOString(),
      chainId: (await ethers.provider.getNetwork()).chainId.toString(),
      modules: {
        Registry: CONTRACT_ADDRESSES.Registry,
        RewardManager: rmAddr,
        RewardView: rvAddr,
        EasyToken: easyTokenAddr,
        GuaranteeFundManager: gfmAddr,
      },
      counters: {
        dataPushedByTypeHash: Object.fromEntries(rewardPushTypes.map((hash) => [hash, rewardPushTypes.filter((v) => v === hash).length])),
      },
      penaltyFlow: {
        target: target.address,
        penaltyBefore: penaltyBefore.toString(),
        penaltyAfter: penaltyAfter.toString(),
        rewardPushTypes,
      },
    });
    console.log("  📦 artifacts:", artifactPath);
    console.log("\n✅ RewardManager governance E2E completed.\n");
  } finally {
    await revertTo(snap);
  }
}

// CLI entrypoint
// eslint-disable-next-line @typescript-eslint/no-var-requires
const _isMain = typeof require !== "undefined" && require.main === module;
if (_isMain) {
  runRewardManagerGovernance().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
