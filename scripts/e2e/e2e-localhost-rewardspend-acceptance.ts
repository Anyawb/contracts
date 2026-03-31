import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { runViewPreflight } from "./utils/view-preflight.ts";
import { envBool, loadAddressMap, resolveAddress } from "../tests/_addressResolver";

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

function mkArtifactsWriter() {
  const outDir = path.join(__dirname, "artifacts");
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch {
    // ignore
  }
  return {
    writeJson: (name: string, data: unknown) => {
      const p = path.join(outDir, name);
      const replacer = (_k: string, v: any) => (typeof v === "bigint" ? v.toString() : v);
      fs.writeFileSync(p, JSON.stringify(data, replacer, 2) + "\n", "utf8");
      return p;
    },
  };
}

function errorSelector(sig: string): string {
  return ethers.id(sig).slice(0, 10);
}

function extractRevertData(e: any): string | undefined {
  const candidates: Array<unknown> = [
    e?.data,
    e?.data?.data,
    e?.error?.data,
    e?.error?.data?.data,
    e?.error?.error?.data,
    e?.info?.error?.data,
    e?.info?.error?.data?.data,
    e?.info?.error?.error?.data,
    e?.receipt?.revertReason,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("0x")) return c;
  }
  const msg = fmtErr(e);
  const m = String(msg).match(/return data:\s*(0x[0-9a-fA-F]+)/);
  return m?.[1];
}

async function mustRevertWithSelector(label: string, fn: () => Promise<unknown>, expectedSig: string) {
  const expectedSel = errorSelector(expectedSig).toLowerCase();
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
    assertOk(!!sel, `${label}: missing revert data (cannot validate selector)`);
    assertOk(sel === expectedSel, `${label}: unexpected selector ${sel}, expected ${expectedSel}`);
    console.log(`  ✅ [revert selector ok] ${label}: ${sel}`);
    return;
  }
  throw new Error(`[FAIL] Expected revert, but succeeded: ${label}`);
}

function hexQuantity(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`invalid hex quantity: ${n}`);
  return `0x${n.toString(16)}`;
}

async function mineBlocks(n: number) {
  await ethers.provider.send("hardhat_mine", [hexQuantity(n)]);
}

async function snapshot(): Promise<string> {
  return await network.provider.send("evm_snapshot", []);
}

async function revertTo(id: string) {
  await network.provider.send("evm_revert", [id]);
}

function findDataPushedPayload(receipt: any, rewardViewAddr: string, expectedTypeHash: string): string {
  const iface = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
  const outLogs = (receipt?.logs ?? []).filter((l: any) => String(l.address ?? "").toLowerCase() === rewardViewAddr.toLowerCase());
  for (const l of outLogs) {
    try {
      const parsed = iface.parseLog({ topics: l.topics as string[], data: l.data });
      if (parsed?.name !== "DataPushed") continue;
      const th = String(parsed.args.dataTypeHash).toLowerCase();
      if (th === expectedTypeHash.toLowerCase()) return parsed.args.payload as string;
    } catch {
      // ignore
    }
  }
  throw new Error(`expected DataPushed(${expectedTypeHash}) not found in receipt`);
}

async function ensureEasyAtLeast(opts: {
  rewardManager: any;
  easyToken: any;
  easyEmissionControllerAddr?: string;
  orderEngineAddr: string;
  adminSigner: any;
  userAddr: string;
  minEasy: bigint;
}) {
  const {
    rewardManager: rm,
    easyToken,
    easyEmissionControllerAddr,
    orderEngineAddr,
    adminSigner,
    userAddr,
    minEasy,
  } = opts;
  const cur = (await easyToken.balanceOf(userAddr)) as bigint;
  if (cur >= minEasy) return;

  // deterministic earn for acceptance: user level=1, multiplier=1x, dynamic disabled
  await (await rm.connect(adminSigner).updateUserLevel(userAddr, 1)).wait();
  await (await rm.connect(adminSigner).setLevelMultiplier(1, 10_000)).wait();
  await (await rm.connect(adminSigner).setDynamicRewardParams(0n, 0n)).wait();

  await network.provider.send("hardhat_impersonateAccount", [orderEngineAddr]);
  await network.provider.send("hardhat_setBalance", [orderEngineAddr, "0x56BC75E2D63100000"]); // 100 ETH
  const oe = await ethers.getSigner(orderEngineAddr);

  const eligibleAmount = ethers.parseUnits("1000", 6);
  const maturity = (await ethers.provider.getBlockNumber()) + 7_200;
  const maxRounds = 30;
  for (let i = 0; i < maxRounds; i++) {
    const balNow = (await easyToken.balanceOf(userAddr)) as bigint;
    if (balNow >= minEasy) return;
    const orderId = BigInt(Math.floor(Date.now() / 1000) + i + 1_000_000);
    await (await rm.connect(oe).onLoanEventByOrder(userAddr, orderId, eligibleAmount, maturity, 0)).wait();
    await (await rm.connect(oe).onLoanEventByOrder(userAddr, orderId, eligibleAmount, maturity, 1)).wait();
  }
  const balEnd = (await easyToken.balanceOf(userAddr)) as bigint;
  if (balEnd < minEasy && easyEmissionControllerAddr) {
    // Fallback: direct mint as EasyEmissionController (minter) on localhost.
    await network.provider.send("hardhat_impersonateAccount", [easyEmissionControllerAddr]);
    await network.provider.send("hardhat_setBalance", [easyEmissionControllerAddr, "0x56BC75E2D63100000"]); // 100 ETH
    const ec = await ethers.getSigner(easyEmissionControllerAddr);
    const deficit = minEasy - balEnd;
    await (await easyToken.connect(ec).mint(userAddr, deficit)).wait();
  }
  const balFinal = (await easyToken.balanceOf(userAddr)) as bigint;
  if (balFinal < minEasy) throw new Error(`cannot mint enough EasyToken: have=${balFinal} need>=${minEasy}`);
}

export async function runRewardSpendAcceptance() {
  const supportsHardhat = network.name === "localhost" || network.name === "hardhat";
  const readOnly = envBool("READ_ONLY", network.name !== "localhost");
  const enableWrite = envBool("ENABLE_WRITE", !readOnly);

  const artifacts = mkArtifactsWriter();
  const dataPushedByTypeHash: Record<string, number> = {};
  const bump = (h: string) => {
    const k = h.toLowerCase();
    dataPushedByTypeHash[k] = (dataPushedByTypeHash[k] ?? 0) + 1;
  };

  const addressMap = loadAddressMap(network.name);
  const registryAddr = resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });

  const snap = supportsHardhat && enableWrite ? await snapshot() : "";
  try {
    const [deployer, user] = await ethers.getSigners();
    console.log(`=== E2E Reward Spend acceptance (EasyConsumption) (${network.name}) ===`);
    console.log(`Config: READ_ONLY=${readOnly} ENABLE_WRITE=${enableWrite}\n`);

    const registry0 = (await ethers.getContractAt("Registry", registryAddr)) as any;
    const acmAddr = (await registry0.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
    const assetForPriceCheck = (await registry0.getModuleOrRevert(key("SETTLEMENT_TOKEN"))) as string;

    await runViewPreflight({
      registryAddr,
      acmAddr,
      adminSigner: deployer,
      assetForPriceCheck,
      // Real-chain mode should not attempt to grant roles; only validate the wiring.
      ensureViewPushRole: enableWrite,
      ensureHealthPushDeps: enableWrite,
    });

    const registry = registry0;
    const rvAddr = (await registry.getModuleOrRevert(key("REWARD_VIEW"))) as string;
    const rmAddr = (await registry.getModuleOrRevert(key("REWARD_MANAGER"))) as string;
    const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;
    const easyTokenAddr = (await registry.getModuleOrRevert(key("EASY_TOKEN"))) as string;
    const easyEmissionControllerAddr = (await registry.getModuleOrRevert(key("EASY_EMISSION_CONTROLLER"))) as string;
    const easyConsumptionAddr = (await registry.getModuleOrRevert(key("EASY_CONSUMPTION"))) as string;
    const easyRecycleAddr = (await registry.getModuleOrRevert(key("EASY_RECYCLE_DISTRIBUTOR"))) as string;

    const rv = (await ethers.getContractAt("RewardView", rvAddr)) as any;
    const rm = (await ethers.getContractAt("RewardManager", rmAddr)) as any;
    const easyToken = (await ethers.getContractAt("src/Token/EasyToken.sol:EasyToken", easyTokenAddr)) as any;
    const easyConsumption = (await ethers.getContractAt("EasyConsumption", easyConsumptionAddr)) as any;

    const easyDecimals = Number(await easyToken.decimals().catch(() => 18));
    const ONE_EASY = 10n ** BigInt(easyDecimals);

    console.log("  RewardView:", rvAddr);
    console.log("  EasyToken:", easyTokenAddr, `(decimals=${easyDecimals})`);
    console.log("  EasyConsumption:", easyConsumptionAddr);
    console.log("  EasyRecycleDistributor:", easyRecycleAddr);

    if (readOnly || !enableWrite) {
      // Real-chain safety default: do not mutate state.
      console.log("  ℹ️  [read-only] skipping EasyConsumption spend (set ENABLE_WRITE=1 if you really want to write)");
      const out = artifacts.writeJson(`rewardspend-acceptance.${Date.now()}.json`, {
        name: "RewardSpend acceptance (read-only)",
        generatedAt: new Date().toISOString(),
        chainId: String((await ethers.provider.getNetwork()).chainId),
        modules: {
          Registry: registryAddr,
          RewardView: rvAddr,
          EasyToken: easyTokenAddr,
          EasyConsumption: easyConsumptionAddr,
        },
        counters: {
          dataPushedByTypeHash,
        },
      });
      console.log(`Artifacts: ${out}`);
      console.log("\n✅ e2e-rewardspend (read-only) PASSED\n");
      return;
    }

    // Ensure we can spend/exchange without depending on dirty state.
    await ensureEasyAtLeast({
      rewardManager: rm,
      easyToken,
      easyEmissionControllerAddr,
      orderEngineAddr,
      adminSigner: deployer,
      userAddr: user.address,
      minEasy: ONE_EASY * 2n,
    });
    // EasyConsumption spend: approve + consume 1 EASY
    const bal0 = (await easyToken.balanceOf(user.address)) as bigint;
    assertOk(bal0 >= ONE_EASY, "insufficient EASY for spend");

    await (await easyToken.connect(user).approve(easyConsumptionAddr, ONE_EASY)).wait();
    const txEasy = await easyConsumption.connect(user).consumeEasiMCall(user.address);
    const rcptEasy = await txEasy.wait();
    const bal1 = (await easyToken.balanceOf(user.address)) as bigint;
    assertOk(bal0 - bal1 === ONE_EASY, "EasyConsumption spend delta mismatch");

    // RewardView DataPushed observability for Easy spend + recycle split
    const easySpent = key("EASY_SPENT");
    const easyRecycled = key("EASY_RECYCLED_SPLIT");
    findDataPushedPayload(rcptEasy, rvAddr, easySpent);
    findDataPushedPayload(rcptEasy, rvAddr, easyRecycled);
    bump(easySpent);
    bump(easyRecycled);

    const out = artifacts.writeJson(`rewardspend-acceptance.${Date.now()}.json`, {
      name: "RewardSpend acceptance (EasyConsumption)",
      generatedAt: new Date().toISOString(),
      chainId: String((await ethers.provider.getNetwork()).chainId),
      modules: {
        Registry: registryAddr,
        RewardView: rvAddr,
        EasyToken: easyTokenAddr,
        EasyConsumption: easyConsumptionAddr,
      },
      counters: {
        dataPushedByTypeHash,
      },
    });
    console.log(`Artifacts: ${out}`);

    console.log("\n✅ e2e-localhost-rewardspend-acceptance PASSED\n");
  } finally {
    if (supportsHardhat && enableWrite) await revertTo(snap);
  }
}

async function main() {
  await runRewardSpendAcceptance();
}

// Only auto-run when invoked directly (not when imported by other suites).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const _isMain = typeof require !== "undefined" && require.main === module;
if (_isMain) {
  main().catch((e) => {
    console.error("\n❌ e2e-localhost-rewardspend-acceptance FAILED\n");
    console.error(e);
    process.exit(1);
  });
}

