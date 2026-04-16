import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { ethers } from "hardhat";

import { envStr } from "../../../../_addressResolver";
import {
  createFundsFlowLiveContext,
  ensureFundsFlowEnvironmentReady,
  getOrderForView,
} from "../core/_fundsFlowLive";
import { getFeeGateContracts } from "../core/_feeLiveUtils";
import { readSeededLiquidationLog } from "../core/_liquidationSeed";
import { key } from "../core/_mockLiveUtils";
import { logLiveScriptFailure, logLiveScriptSuccess } from "../core/_scriptStatus";

type ScriptStep = {
  id: string;
  label: string;
  file: string;
};

function networkScriptDir(network: string) {
  switch (network) {
    case "bnbTestnet":
      return "bnb-testnet";
    case "arbitrumSepolia":
      return "arbitrum-sepolia";
    default:
      throw new Error(`unsupported LIVE_RELEASE network: ${network}`);
  }
}

function requireNetworkEnv(name: string): string {
  const value = envStr(name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function pnpmBin(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function nowId() {
  return new Date().toISOString().replace(/[-:TZ.]/g, "");
}

function runReadOnlyScript(step: ScriptStep, network: string, logFile: string) {
  const result = spawnSync(pnpmBin(), ["-s", "exec", "hardhat", "run", step.file, "--network", network], {
    env: process.env,
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  fs.writeFileSync(logFile, output, "utf8");
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  return { status: result.status ?? 1, logFile };
}

async function main() {
  const network = requireNetworkEnv("LIVE_RELEASE_NETWORK");
  if (network === "localhost" || network === "hardhat") {
    throw new Error(
      `LIVE_RELEASE_NETWORK must be an explicit live wrapper network, received ${network}; choose bnbTestnet or arbitrumSepolia`,
    );
  }
  const scriptDir = networkScriptDir(network);
  const logDir = path.join(process.cwd(), "scripts", "tests", "logs", `live-release-dryrun-${network}-${nowId()}`);
  fs.mkdirSync(logDir, { recursive: true });

  console.log("=== Live Release Dry Run ===");
  console.log(`network=${network}`);
  console.log(`logDir=${logDir}`);
  console.log("mode=zero-write");

  const readOnlySteps: ScriptStep[] = [
    {
      id: "01-asset-precheck",
      label: "asset precheck",
      file: `scripts/tests/live-test/networks/${scriptDir}/live-asset-precheck.ts`,
    },
    {
      id: "02-preflight",
      label: "protocol preflight",
      file: `scripts/tests/live-test/networks/${scriptDir}/live-preflight.ts`,
    },
  ];

  for (const step of readOnlySteps) {
    console.log(`\n=== ${step.label} ===`);
    const result = runReadOnlyScript(step, network, path.join(logDir, `${step.id}.log`));
    if (result.status !== 0) {
      throw new Error(`${step.label} failed; see ${result.logFile}`);
    }
  }

  const ctx = await createFundsFlowLiveContext({
    label: "Live Release Dry Run",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  await ensureFundsFlowEnvironmentReady(ctx);

  const { feeRouter } = await getFeeGateContracts(ctx);
  const relayerBorrowBalance = (await ctx.borrowToken.balanceOf(ctx.relayer.address)) as bigint;
  const feeRouterBorrowBalance = (await ctx.borrowToken.balanceOf(ctx.feeRouterAddr)) as bigint;
  const normalAmount = ethers.parseUnits(envStr("FEE_REMAINING_AMOUNT_UNITS") ?? "100", ctx.borrowDecimals);
  const prepaidAmount = ethers.parseUnits(envStr("FEE_PREPAID_AMOUNT_UNITS") ?? "50", ctx.borrowDecimals);
  const dynamicAmount = ethers.parseUnits(envStr("FEE_DYNAMIC_AMOUNT_UNITS") ?? "100", ctx.borrowDecimals);
  const dynamicFeeTypeName = envStr("FEE_DYNAMIC_TYPE_NAME") ?? "LIVE_DYNAMIC_FEE_TEST";
  const dynamicFeeType = ethers.keccak256(ethers.toUtf8Bytes(dynamicFeeTypeName));
  const prepaidFeeTypeName = envStr("FEE_PREPAID_TYPE_NAME") ?? "LIQUIDATION_PLATFORM_SHARE";
  const prepaidFeeType = ethers.keccak256(ethers.toUtf8Bytes(prepaidFeeTypeName));

  const hasLiquidate = (await ctx.acm.hasRole(key("LIQUIDATE"), ctx.relayer.address)) as boolean;
  const hasUpdatePrice = (await ctx.acm.hasRole(key("UPDATE_PRICE"), ctx.relayer.address)) as boolean;
  const hasActionAdmin = (await ctx.acm.hasRole(key("ACTION_ADMIN"), ctx.relayer.address)) as boolean;
  const hasDeposit = (await ctx.acm.hasRole(key("DEPOSIT"), ctx.relayer.address)) as boolean;
  const hasSetParameter = (await ctx.acm.hasRole(key("SET_PARAMETER"), ctx.relayer.address)) as boolean;

  console.log("\n=== Role Readiness ===");
  console.log(`relayer=${ctx.relayer.address}`);
  console.log(`LIQUIDATE=${hasLiquidate}`);
  console.log(`UPDATE_PRICE=${hasUpdatePrice}`);
  console.log(`ACTION_ADMIN=${hasActionAdmin}`);
  console.log(`DEPOSIT=${hasDeposit}`);
  console.log(`SET_PARAMETER=${hasSetParameter}`);

  console.log("\n=== Fee Dry Run ===");
  console.log(`relayerBorrowBalance=${relayerBorrowBalance.toString()}`);
  console.log(`feeRouterBorrowBalance=${feeRouterBorrowBalance.toString()}`);

  if (!hasDeposit) {
    console.log("WARN distributeNormal/distributeDynamic dry-run skipped: relayer lacks DEPOSIT");
  } else {
    try {
      await feeRouter.connect(ctx.relayer).distributeNormal.staticCall(ctx.borrowAssetAddr, normalAmount);
      console.log(`PASS distributeNormal.staticCall amount=${normalAmount.toString()}`);
    } catch (error) {
      console.log(`WARN distributeNormal.staticCall failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      await feeRouter.connect(ctx.relayer).distributeDynamic.staticCall(ctx.borrowAssetAddr, dynamicAmount, dynamicFeeType);
      console.log(`PASS distributeDynamic.staticCall amount=${dynamicAmount.toString()} feeType=${dynamicFeeTypeName}`);
    } catch (error) {
      console.log(`WARN distributeDynamic.staticCall failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!hasDeposit) {
    console.log("WARN distributePrepaid dry-run skipped: relayer lacks DEPOSIT");
  } else if (feeRouterBorrowBalance < prepaidAmount) {
    console.log(
      `WARN distributePrepaid.staticCall skipped: FeeRouter balance is insufficient (need=${prepaidAmount.toString()} have=${feeRouterBorrowBalance.toString()})`,
    );
  } else {
    try {
      await feeRouter.connect(ctx.relayer).distributePrepaid.staticCall(
        ctx.borrowAssetAddr,
        prepaidAmount,
        prepaidFeeType,
        ctx.relayer.address,
      );
      console.log(`PASS distributePrepaid.staticCall amount=${prepaidAmount.toString()} feeType=${prepaidFeeTypeName}`);
    } catch (error) {
      console.log(`WARN distributePrepaid.staticCall failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const configuredDynamicFee = (await feeRouter.getDynamicFee(ctx.borrowAssetAddr, dynamicFeeType)) as bigint;
  console.log(`dynamicFeeConfigured=${configuredDynamicFee.toString()} feeType=${dynamicFeeTypeName}`);
  if (configuredDynamicFee === 0n && !hasSetParameter) {
    console.log("WARN dynamic fee dry-run cannot fully cover write-mode fallback: feeType is unconfigured and relayer lacks SET_PARAMETER");
  }

  console.log("\n=== Liquidation Dry Run ===");
  const configuredOrderId = envStr("LIQUIDATION_ORDER_ID");
  const configuredSeedLogFile = envStr("LIQUIDATION_SEED_LOG_FILE");
  let resolvedOrderId = configuredOrderId;
  if (!resolvedOrderId && configuredSeedLogFile) {
    const seeded = readSeededLiquidationLog(configuredSeedLogFile);
    resolvedOrderId = seeded.orderId.toString();
    console.log(`INFO liquidation dry-run using seeded order from ${configuredSeedLogFile}: orderId=${resolvedOrderId} borrower=${seeded.borrower}`);
  }
  if (!resolvedOrderId) {
    console.log("WARN liquidation dry-run skipped: missing LIQUIDATION_ORDER_ID");
  } else {
    const orderId = BigInt(resolvedOrderId);
    const order = await getOrderForView(ctx, orderId);
    const currentBlock = BigInt(await ethers.provider.getBlockNumber());
    const debtAsset = order.asset;
    const registry = (await ethers.getContractAt(
      ["function getModuleOrRevert(bytes32) view returns (address)"],
      ctx.registryAddr,
    )) as any;
    const lendingEngineAddr = (await registry.getModuleOrRevert(key("LENDING_ENGINE"))) as string;
    const liquidationViewAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_VIEW"))) as string;
    const lendingEngine = (await ethers.getContractAt(
      [
        "function getDebt(address user,address asset) view returns (uint256)",
        "function getReducibleDebtAmount(address user,address asset) view returns (uint256)",
      ],
      lendingEngineAddr,
      ctx.viewer,
    )) as any;
    const liquidatorView = (await ethers.getContractAt(
      ["function getSeizableCollaterals(address user) view returns (address[] memory,uint256[] memory,uint256,bool)"],
      liquidationViewAddr,
      ctx.viewer,
    )) as any;
    const settlementManager = (await ethers.getContractAt(
      ["function settleOrLiquidate(uint256 orderId)"],
      ctx.settlementManagerAddr,
      ctx.relayer,
    )) as any;

    const debt = (await lendingEngine.getDebt(order.borrower, debtAsset)) as bigint;
    const reducible = (await lendingEngine.getReducibleDebtAmount(order.borrower, debtAsset)) as bigint;
    let assets: string[] = [];
    let amounts: bigint[] = [];
    let totalSeizable = 0n;
    try {
      [assets, amounts] = (await liquidatorView.getSeizableCollaterals(order.borrower)) as [string[], bigint[], bigint, boolean];
      totalSeizable = amounts.reduce((sum, value) => sum + value, 0n);
    } catch (error) {
      console.log(`WARN getSeizableCollaterals failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    console.log(`orderId=${orderId.toString()}`);
    console.log(`borrower=${order.borrower}`);
    console.log(`maturity=${order.maturity.toString()} currentBlock=${currentBlock.toString()} overdue=${String(currentBlock > order.maturity)}`);
    console.log(`debt=${debt.toString()} reducible=${reducible.toString()} seizableAssets=${assets.length} totalSeizable=${totalSeizable.toString()}`);

    if (!hasLiquidate) {
      console.log("WARN liquidation staticCall skipped: relayer lacks LIQUIDATE");
    } else {
      try {
        await settlementManager.connect(ctx.relayer).settleOrLiquidate.staticCall(orderId);
        console.log("PASS settleOrLiquidate.staticCall");
      } catch (error) {
        console.log(`WARN settleOrLiquidate.staticCall failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!hasActionAdmin) {
      console.log("WARN fallback write-mode is not ready on live: relayer lacks ACTION_ADMIN");
    } else {
      console.log("INFO fallback precondition satisfied at role level: relayer can pause LiquidationManager if runbook允许");
    }
    if (!hasUpdatePrice) {
      console.log("WARN liquidation write-mode is not ready on live: relayer lacks UPDATE_PRICE for keeper refresh runbook");
    }
  }

  logLiveScriptSuccess(__filename, "COMPLETED");
}

export const liveScriptPromise = main().catch((error) => {
  logLiveScriptFailure(__filename, error);
  process.exit(1);
});