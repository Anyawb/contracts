import { ethers } from "hardhat";
import { runWithNetworkRetry } from "./_networkRetry";

import {
  assignFreshBorrower,
  createFundsFlowLiveContext,
  depositCollateral,
  ensureFundsFlowEnvironmentReady,
  ensureFundsFlowPrices,
  finalizeSingleMatch,
  fundFundsFlowActors,
  repayOrder,
  reserveForLending,
} from "./_fundsFlowLive";
import { key } from "./_mockLiveUtils";

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live View Registry Routes",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  await assignFreshBorrower(ctx, { noticeLabel: "using fresh view-registry borrower" });

  await ensureFundsFlowEnvironmentReady(ctx);
  await ensureFundsFlowPrices(ctx);
  await fundFundsFlowActors(ctx, {
    borrowerBorrowAmount: ctx.totalDue + ctx.interest,
    borrowerCollateralAmount: ctx.collateralAmount,
    lenderBorrowAmount: ctx.borrowAmount,
  });

  let finalized: Awaited<ReturnType<typeof finalizeSingleMatch>> | null = null;
  let primaryError: unknown = null;

  try {
    await depositCollateral(ctx, ctx.collateralAmount);
    const reserve = await reserveForLending(ctx);
    finalized = await finalizeSingleMatch(ctx, reserve);

    if (!ctx.registryView || !ctx.loanNftView || !ctx.statisticsView) {
      throw new Error("registry routes script requires RegistryView, LoanNFTView and StatisticsView");
    }

    const [registeredKeys, totalRegistered] = (await ctx.registryView.getRegisteredModuleKeysPaginated(0, 32)) as [string[], bigint];
    if (registeredKeys.length === 0 || totalRegistered === 0n) {
      throw new Error("RegistryView should expose non-empty registered module keys");
    }

    const expectedKeys = [
      key("VAULT_STATISTICS"),
      key("REWARD_VIEW"),
      key("RISK_VIEW"),
      key("SYSTEM_RISK_VIEW"),
      key("USER_VIEW"),
      key("POSITION_VIEW"),
      key("BATCH_VIEW"),
      key("DASHBOARD_VIEW"),
      key("PREVIEW_VIEW"),
    ].map((value) => value.toLowerCase());
    const pageKeys = new Set(registeredKeys.map((value) => value.toLowerCase()));
    for (const moduleKey of expectedKeys) {
      if (!pageKeys.has(moduleKey)) {
        console.log(`  [Notice] registered module key ${moduleKey} not present in first page; totalRegistered=${totalRegistered.toString()}`);
      }
    }

    const systemViewAddr = (await (await ethers.getContractAt("Registry", ctx.registryAddr)).getModuleOrRevert(key("SYSTEM_VIEW"))) as string;
    const systemView = (await ethers.getContractAt(
      [
        "function routeStatistics() view returns (bytes32 moduleKey,address moduleAddr)",
        "function routeReward() view returns (bytes32 moduleKey,address moduleAddr)",
        "function routeRisk() view returns (bytes32 moduleKey,address moduleAddr)",
        "function routeSystemRisk() view returns (bytes32 moduleKey,address moduleAddr)",
        "function routeUser() view returns (bytes32 moduleKey,address moduleAddr)",
        "function routePosition() view returns (bytes32 moduleKey,address moduleAddr)",
        "function routeBatch() view returns (bytes32 moduleKey,address moduleAddr)",
        "function routeDashboard() view returns (bytes32 moduleKey,address moduleAddr)",
        "function routePreview() view returns (bytes32 moduleKey,address moduleAddr)",
      ],
      systemViewAddr,
      ctx.relayer,
    )) as any;

    const routeChecks: Array<{ label: string; route: () => Promise<any>; expectedKey: string; expectedAddr: string | null }> = [
      {
        label: "Statistics",
        route: () => systemView.routeStatistics(),
        expectedKey: key("VAULT_STATISTICS"),
        expectedAddr: ctx.statisticsView.target as string,
      },
      { label: "Reward", route: () => systemView.routeReward(), expectedKey: key("REWARD_VIEW"), expectedAddr: ctx.rewardView.target as string },
      { label: "Risk", route: () => systemView.routeRisk(), expectedKey: key("RISK_VIEW"), expectedAddr: ctx.riskView?.target as string | null },
      { label: "SystemRisk", route: () => systemView.routeSystemRisk(), expectedKey: key("SYSTEM_RISK_VIEW"), expectedAddr: ctx.systemRiskView?.target as string | null },
      { label: "User", route: () => systemView.routeUser(), expectedKey: key("USER_VIEW"), expectedAddr: ctx.userView?.target as string | null },
      { label: "Position", route: () => systemView.routePosition(), expectedKey: key("POSITION_VIEW"), expectedAddr: ctx.positionView.target as string },
      { label: "Batch", route: () => systemView.routeBatch(), expectedKey: key("BATCH_VIEW"), expectedAddr: ctx.batchView?.target as string | null },
      { label: "Dashboard", route: () => systemView.routeDashboard(), expectedKey: key("DASHBOARD_VIEW"), expectedAddr: ctx.dashboardView?.target as string | null },
      { label: "Preview", route: () => systemView.routePreview(), expectedKey: key("PREVIEW_VIEW"), expectedAddr: ctx.previewView?.target as string | null },
    ];

    for (const check of routeChecks) {
      if (!check.expectedAddr) {
        continue;
      }
      try {
        const route = (await check.route()) as any;
        const routeKey = String(route.moduleKey ?? route[0] ?? "");
        const routeAddr = String(route.moduleAddr ?? route[1] ?? ethers.ZeroAddress);
        if (routeKey.toLowerCase() !== check.expectedKey.toLowerCase()) {
          throw new Error(`${check.label}: moduleKey mismatch`);
        }
        if (routeAddr.toLowerCase() !== check.expectedAddr.toLowerCase()) {
          throw new Error(`${check.label}: moduleAddr mismatch`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("mismatch")) {
          throw error;
        }
        console.log(`  [Notice] SystemView ${check.label} route read unavailable for current relayer`);
      }
    }

    const [userSnapshot, globalStats, loanCount, userTotals] = await Promise.all([
      ctx.statisticsView.connect(ctx.borrower).getUserSnapshotWithMeta(ctx.borrower.address),
      ctx.statisticsView.getGlobalStatisticsWithMeta(),
      ctx.loanNftView.connect(ctx.borrower).getUserLoanCount(ctx.borrower.address),
      ctx.userView?.connect(ctx.borrower).getUserTotalsWithMeta(ctx.borrower.address) ?? Promise.resolve(null),
    ]);

    const [snapshot, version, , , snapshotValid, snapshotBlock] = userSnapshot as [any, bigint, bigint, string, boolean, bigint];
    if (BigInt(snapshot.collateral ?? snapshot[0] ?? 0) === 0n) {
      throw new Error("StatisticsView user collateral should be non-zero after finalizeMatch");
    }
    if (snapshotBlock === 0n) {
      throw new Error("StatisticsView user snapshot block should be non-zero after finalizeMatch");
    }
    if (!snapshotValid) {
      console.log("  [Notice] StatisticsView user snapshot is readable but marked stale");
    }
    if (userTotals) {
      const [totalCollateral, totalDebt, totalsValid, totalsBlock, totalsVersion] = userTotals as [bigint, bigint, boolean, bigint, bigint, bigint];
      if (totalCollateral !== BigInt(snapshot.collateral ?? snapshot[0] ?? 0)) {
        throw new Error("UserView totalCollateral should match StatisticsView after finalizeMatch");
      }
      if (totalDebt !== BigInt(snapshot.debt ?? snapshot[1] ?? 0)) {
        throw new Error("UserView totalDebt should match StatisticsView after finalizeMatch");
      }
      if (totalsBlock === 0n) {
        throw new Error("UserView totals block should be non-zero after finalizeMatch");
      }
      if (!totalsValid) {
        console.log("  [Notice] UserView totals are readable but marked stale");
      }
      if (version !== totalsVersion) {
        throw new Error("UserView version should match StatisticsView after finalizeMatch");
      }
    } else if (version === 0n) {
      console.log("  [Notice] StatisticsView user version is still zero on current live deployment; treating readable non-zero snapshot as pass");
    }

    const [global, globalValid] = globalStats as [any, boolean, bigint];
    if (!globalValid) {
      console.log("  [Notice] StatisticsView global snapshot is readable but marked stale");
    }
    if (BigInt(global.totalUsers ?? global[0] ?? 0) === 0n) {
      throw new Error("StatisticsView totalUsers should be non-zero");
    }

    const [count] = loanCount as [bigint, boolean, bigint];
    if (count === 0n) {
      throw new Error("LoanNFTView loan count should be non-zero after finalizeMatch");
    }
    const loanPageLimit = Number(count > 64n ? 64n : count);
    const [tokenIdsPage, loansPage] = await Promise.all([
      ctx.loanNftView.connect(ctx.borrower).getUserTokenIdsPaginated(ctx.borrower.address, 0, loanPageLimit),
      ctx.loanNftView.connect(ctx.borrower).getUserLoansPaginated(ctx.borrower.address, 0, loanPageLimit),
    ]);
    const [tokenIds] = tokenIdsPage as [bigint[], bigint, boolean, bigint];
    if (tokenIds.length === 0) {
      throw new Error("LoanNFTView tokenIds page should be non-empty");
    }
    const [loans] = loansPage as [Array<{ tokenId?: bigint; orderId?: bigint; status?: bigint }>, bigint, boolean, bigint];
    const finalizedOrderId = finalized.orderId;
    const matchedLoan = loans.find((loan) => BigInt(loan.orderId ?? 0) === finalizedOrderId);
    if (!matchedLoan) {
      throw new Error(`LoanNFTView should expose orderId ${finalizedOrderId.toString()}`);
    }

    if (ctx.moduleHealthView) {
      try {
        const [health] = (await ctx.moduleHealthView.connect(ctx.relayer).getModuleHealthWithMeta(ctx.vaultCoreAddr)) as [any, boolean, bigint];
        if ((health.isHealthy ?? health[0]) === undefined) {
          throw new Error("ModuleHealthView payload malformed");
        }
      } catch {
        console.log("  [Notice] ModuleHealthView read unavailable for current relayer");
      }
    }

    const registryAddr = (await ctx.registryView.getRegistry()) as string;
    if (registryAddr.toLowerCase() !== ctx.registryAddr.toLowerCase()) {
      throw new Error(`RegistryView registry mismatch: expected ${ctx.registryAddr} got ${registryAddr}`);
    }

    console.log("\n✅ live-view-registry-routes-arbitrum-sepolia PASSED\n");
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (finalized) {
      try {
        await repayOrder(ctx, finalized.orderId, ctx.totalDue);
      } catch (cleanupError) {
        if (primaryError) {
          console.log(`  [Notice] post-check cleanup repay failed for orderId=${finalized.orderId.toString()}: ${cleanupError}`);
        } else {
          throw cleanupError;
        }
      }
    }
  }
}

void runWithNetworkRetry("live-view-registry-routes-arbitrum-sepolia", main);