import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { runViewPreflight } from "./utils/view-preflight.ts";
import { runRewardExtendedChecks } from "./utils/reward-extended-checks.ts";
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

const DATA_PUSH_IFACE = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
const DATA_PUSH_TOPIC0 = ethers.id("DataPushed(bytes32,bytes)").toLowerCase();

function getDataPushTypes(receipt: any, emitter?: string): string[] {
  return (receipt?.logs ?? [])
    .filter((log: any) => {
      if ((log?.topics?.[0] || "").toLowerCase() !== DATA_PUSH_TOPIC0) return false;
      if (!emitter) return true;
      return String(log.address ?? "").toLowerCase() === emitter.toLowerCase();
    })
    .map((log: any) => DATA_PUSH_IFACE.parseLog(log))
    .filter((parsed: any) => parsed)
    .map((parsed: any) => parsed.args.dataTypeHash.toLowerCase());
}

function hasDataPush(receipt: any, emitter: string, typeHash: string): boolean {
  return getDataPushTypes(receipt, emitter).some((t) => t === typeHash.toLowerCase());
}

export async function runRewardViewAcceptance() {
  const supportsHardhat = network.name === "localhost" || network.name === "hardhat";
  const readOnly = envBool("READ_ONLY", network.name !== "localhost");
  const enableWrite = envBool("ENABLE_WRITE", !readOnly);
  const strictDataPush = envBool("E2E_STRICT_DATAPUSH", false);
  const strictReward = envBool("E2E_STRICT_REWARD", false);

  const artifacts = mkArtifactsWriter();
  const dataPushedByTypeHash: Record<string, number> = {};
  const bump = (h: string) => {
    const k = h.toLowerCase();
    dataPushedByTypeHash[k] = (dataPushedByTypeHash[k] ?? 0) + 1;
  };
  const recordDataPush = (receipt: any, emitter: string) => {
    for (const h of getDataPushTypes(receipt, emitter)) bump(h);
  };

  const addressMap = loadAddressMap(network.name);
  const registryAddr = resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });

  const snap = supportsHardhat && enableWrite ? await network.provider.send("evm_snapshot", []) : "";
  try {
    const [deployer, borrower, lender, outsider] = await ethers.getSigners();

    console.log(`=== E2E RewardView acceptance (${network.name}) ===`);
    console.log(`Config: READ_ONLY=${readOnly} ENABLE_WRITE=${enableWrite} STRICT_DATAPUSH=${strictDataPush}\n`);

    const registry = (await ethers.getContractAt("Registry", registryAddr)) as any;
    const acmAddr = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
    const assetForPriceCheck = (await registry.getModuleOrRevert(key("SETTLEMENT_TOKEN"))) as string;

    await runViewPreflight({
      registryAddr,
      acmAddr,
      adminSigner: deployer,
      assetForPriceCheck,
      ensureViewPushRole: enableWrite,
      ensureHealthPushDeps: enableWrite,
    });

    const rewardViewAddr = (await registry.getModuleOrRevert(key("REWARD_VIEW"))) as string;
    const rewardManagerAddr = (await registry.getModuleOrRevert(key("REWARD_MANAGER"))) as string;
    const rewardAccrualManagerAddr = (await registry.getModuleOrRevert(key("REWARD_ACCRUAL_MANAGER"))) as string;
    const rewardManagerCoreAddr = (await registry.getModuleOrRevert(key("REWARD_MANAGER_CORE"))) as string;
    const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;
    const easyTokenAddr = (await registry.getModuleOrRevert(key("EASY_TOKEN"))) as string;
    const easyEmissionConfigAddr = (await registry.getModule(key("EASY_EMISSION_CONFIG"))) as string;
    const easyEmissionControllerAddr = (await registry.getModule(key("EASY_EMISSION_CONTROLLER"))) as string;
    const priceOracleAddr = (await registry.getModuleOrRevert(key("PRICE_ORACLE"))) as string;

    const rewardView = (await ethers.getContractAt("RewardView", rewardViewAddr)) as any;
    const rewardManager = (await ethers.getContractAt("RewardManager", rewardManagerAddr)) as any;
    const rewardAccrualManager = (await ethers.getContractAt("RewardAccrualManager", rewardAccrualManagerAddr)) as any;
    const easyToken = (await ethers.getContractAt("src/Token/EasyToken.sol:EasyToken", easyTokenAddr)) as any;
    const priceOracle = (await ethers.getContractAt("PriceOracle", priceOracleAddr)) as any;
    const easyEmissionConfig =
      easyEmissionConfigAddr && easyEmissionConfigAddr !== ethers.ZeroAddress
        ? ((await ethers.getContractAt("EasyEmissionConfig", easyEmissionConfigAddr)) as any)
        : null;

    const rewardExtendedArtifact: Record<string, any> = {};

    console.log("  RewardView:", rewardViewAddr);
    console.log("  RewardManager:", rewardManagerAddr);
    console.log("  RewardManagerCore:", rewardManagerCoreAddr);
    console.log("  EasyToken:", easyTokenAddr);

    if (readOnly || !enableWrite) {
      await rewardView.connect(deployer).getUserRewardSummaryWithMeta(deployer.address);
      console.log("\n✅ e2e-localhost-rewardview-acceptance (read-only) PASSED\n");
      const out = artifacts.writeJson(`rewardview-acceptance.${Date.now()}.json`, {
        name: "RewardView acceptance (read-only)",
        generatedAt: new Date().toISOString(),
        chainId: String((await ethers.provider.getNetwork()).chainId),
        strictDataPush,
        modules: {
          Registry: registryAddr,
          RewardView: rewardViewAddr,
          RewardManagerCore: rewardManagerCoreAddr,
          EasyToken: easyTokenAddr,
        },
        counters: {
          dataPushedByTypeHash,
        },
      });
      console.log(`Artifacts: ${out}`);
      return;
    }

    await assertOkPushWriter(rewardView, outsider.address);

    if (easyEmissionControllerAddr && easyEmissionControllerAddr !== ethers.ZeroAddress) {
      const minterRole = await easyToken.MINTER_ROLE();
      const hasMinter = await easyToken.hasRole(minterRole, easyEmissionControllerAddr);
      if (!hasMinter) {
        await (await easyToken.connect(deployer).setSoleMinter(easyEmissionControllerAddr)).wait();
        console.log("  ✅ EasyToken sole minter set to EasyEmissionController");
      }
    } else {
      console.log("  [Notice] EASY_EMISSION_CONTROLLER not bound; Easy mint checks will be skipped");
    }

    // Easy mint + RewardView EASY_MINTED push (repay full path)
    let price = 0n;
    let assetDecimals = 0n;
    try {
      [price, , assetDecimals] = (await priceOracle.getPrice(assetForPriceCheck)) as [bigint, bigint, bigint];
    } catch {
      // leave price/decimals as 0
    }
    const eligible = price > 0n && assetDecimals > 0n;
    if (!eligible) {
      console.log("  [Notice] price oracle unavailable; skip Easy mint assertions");
    }

    const orderId = BigInt(Date.now());
    const maturity = BigInt((await ethers.provider.getBlockNumber()) + 7_200);
    const amountBaseUnits = eligible
      ? 1100n * 10n ** assetDecimals
      : 1100n * 10n ** 6n;

    await network.provider.send("hardhat_impersonateAccount", [orderEngineAddr]);
    await network.provider.send("hardhat_setBalance", [orderEngineAddr, "0x56BC75E2D63100000"]);
    const oe = await ethers.getSigner(orderEngineAddr);

    const borrowerBal0 = (await easyToken.balanceOf(borrower.address)) as bigint;
    const lenderBal0 = (await easyToken.balanceOf(lender.address)) as bigint;
    const [earned0] = await rewardView.connect(deployer).getUserEasyEarnedWithMeta(borrower.address);

    const tx = await rewardManager.connect(oe).onLoanEventByOrderWithLender(
      borrower.address,
      lender.address,
      assetForPriceCheck,
      orderId,
      amountBaseUnits,
      maturity,
      1
    );
    const receipt = await tx.wait();
    recordDataPush(receipt, rewardViewAddr);

    if (eligible && easyEmissionControllerAddr && easyEmissionControllerAddr !== ethers.ZeroAddress) {
      const borrowerBal1 = (await easyToken.balanceOf(borrower.address)) as bigint;
      const lenderBal1 = (await easyToken.balanceOf(lender.address)) as bigint;
      const [earned1] = await rewardView.connect(deployer).getUserEasyEarnedWithMeta(borrower.address);

      assertOk(borrowerBal1 > borrowerBal0, "borrower Easy balance did not increase");
      assertOk(lenderBal1 > lenderBal0, "lender Easy balance did not increase");
      assertOk(earned1 > earned0, "RewardView.easyEarned did not increase");

      const hasEasyMinted = hasDataPush(receipt, rewardViewAddr, key("EASY_MINTED"));
      if (!hasEasyMinted) {
        const msg = "missing DataPushed(EASY_MINTED) in repay receipt";
        if (strictDataPush) throw new Error(msg);
        console.log(`  [Notice] ${msg}`);
      }
    }

    // Penalty ledger push on late repay (no Easy balance)
    const penaltyUser = ethers.Wallet.createRandom().address;
    const penaltyOrderId = BigInt(Date.now() + 1000);
    const penaltyAmount = 1000n * 10n ** 6n; // MIN_ELIGIBLE_PRINCIPAL

    await (await rewardManager.connect(oe).onLoanEventByOrder(penaltyUser, penaltyOrderId, penaltyAmount, maturity, 0)).wait();
    const txLate = await rewardManager
      .connect(oe)
      .onLoanEventByOrder(penaltyUser, penaltyOrderId, penaltyAmount, maturity, 3);
    const rcptLate = await txLate.wait();
    recordDataPush(rcptLate, rewardViewAddr);

    const penaltySummary = await rewardView.connect(deployer).getUserRewardSummaryWithMeta(penaltyUser);
    const pendingPenalty = penaltySummary[1] as bigint;
    assertOk(pendingPenalty > 0n, "pendingPenalty should increase on late repay with no balance");

    const hasPenaltyPush = hasDataPush(rcptLate, rewardViewAddr, key("REWARD_PENALTY_LEDGER_UPDATED"));
    if (!hasPenaltyPush) {
      const msg = "missing DataPushed(REWARD_PENALTY_LEDGER_UPDATED) in late repay receipt";
      if (strictDataPush) throw new Error(msg);
      console.log(`  [Notice] ${msg}`);
    }

    // Governance observability pushes (best-effort)
    if (easyEmissionConfigAddr && easyEmissionConfigAddr !== ethers.ZeroAddress) {
      const acm = (await ethers.getContractAt("AccessControlManager", acmAddr)) as any;
      const hasParam = (await acm.hasRole(key("SET_PARAMETER"), deployer.address)) as boolean;
      if (hasParam) {
        const txDyn = await rewardManager.connect(deployer).setDynamicRewardParams(0n, 0n);
        const rcptDyn = await txDyn.wait();
        recordDataPush(rcptDyn, rewardViewAddr);
        if (!hasDataPush(rcptDyn, rewardViewAddr, key("REWARD_DYNAMIC_REWARD_PARAMS_UPDATED")) && strictDataPush) {
          throw new Error("missing DataPushed(REWARD_DYNAMIC_REWARD_PARAMS_UPDATED)");
        }

        const txLvl = await rewardManager.connect(deployer).setLevelMultiplier(1, 10_000);
        const rcptLvl = await txLvl.wait();
        recordDataPush(rcptLvl, rewardViewAddr);
        if (!hasDataPush(rcptLvl, rewardViewAddr, key("REWARD_LEVEL_MULTIPLIER_UPDATED")) && strictDataPush) {
          throw new Error("missing DataPushed(REWARD_LEVEL_MULTIPLIER_UPDATED)");
        }
      } else {
        console.log("  [Notice] missing SET_PARAMETER role; skip governance observability checks");
      }
    }

    await runRewardExtendedChecks({
      registry,
      acm: await ethers.getContractAt("AccessControlManager", acmAddr),
      deployer,
      waitTx: async (p: Promise<any>, _label: string) => {
        const tx = await p;
        return tx.wait();
      },
      strictReward,
      rewardView,
      rewardViewAddr,
      easyEmissionConfig,
      easyEmissionConfigAddr,
      rewardAccrualManager,
      ramAddr: rewardAccrualManagerAddr,
      rmCoreAddr: rewardManagerCoreAddr,
      artifactTarget: rewardExtendedArtifact,
      artifactKey: "rewardExtendedChecks",
      log: console.log,
      logNotice: console.log,
    });

    const out = artifacts.writeJson(`rewardview-acceptance.${Date.now()}.json`, {
      name: "RewardView acceptance (ARCH 4.14)",
      generatedAt: new Date().toISOString(),
      chainId: String((await ethers.provider.getNetwork()).chainId),
      strictDataPush,
      modules: {
        Registry: registryAddr,
        RewardView: rewardViewAddr,
        RewardManagerCore: rewardManagerCoreAddr,
        EasyToken: easyTokenAddr,
      },
      counters: {
        dataPushedByTypeHash,
      },
      rewardExtendedChecks: rewardExtendedArtifact.rewardExtendedChecks,
    });
    console.log(`Artifacts: ${out}`);

    console.log("\n✅ e2e-localhost-rewardview-acceptance PASSED\n");
  } finally {
    if (supportsHardhat && enableWrite) await network.provider.send("evm_revert", [snap]);
  }
}

async function assertOkPushWriter(rewardView: any, outsiderAddr: string) {
  try {
    await rewardView.connect(await ethers.getSigner(outsiderAddr)).pushPenaltyLedger(outsiderAddr, 1n, 1n);
  } catch (e: any) {
    const msg = fmtErr(e);
    if (isMissingSelectorError(String(msg))) {
      throw new Error(
        "RewardView ABI mismatch: pushPenaltyLedger selector missing. Re-run compile + deploy:localhost."
      );
    }
    return;
  }
  throw new Error("RewardView pushPenaltyLedger should be writer-gated, but call succeeded");
}

async function main() {
  await runRewardViewAcceptance();
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const _isMain = typeof require !== "undefined" && require.main === module;
if (_isMain) {
  main().catch((e) => {
    console.error("\n❌ e2e-localhost-rewardview-acceptance FAILED\n");
    console.error(e);
    process.exit(1);
  });
}
