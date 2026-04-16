export const ONE_EASY = 10n ** 18n;

export type RewardObservedUserState = {
  easyBalance: bigint;
  penaltyDebt: bigint;
  pendingPenalty: bigint;
  level: bigint;
  lockedEasy: bigint;
  eligibleLoanCount: bigint;
  onTimeRepayCount: bigint;
  totalBurned: bigint;
};

export type RewardCommand =
  | {
      type: "setLevelMultiplier";
      level: bigint;
      multiplierBps: bigint;
    }
  | {
      type: "setDynamicRewardParams";
      thresholdEasy: bigint;
      dynamicMultiplierBps: bigint;
    }
  | {
      type: "setLatePenaltyBps";
      latePenaltyBps: bigint;
    }
  | {
      type: "setLiquidationPenaltyBps";
      liquidationPenaltyBps: bigint;
    }
  | {
      type: "updateUserLevel";
      actor: string;
      level: bigint;
    }
  | {
      type: "borrow";
      borrower: string;
      lender: string;
      asset: string;
      orderId: bigint;
      amountBaseUnits: bigint;
      maturity: bigint;
      assertUsersAfter?: string[];
    }
  | {
      type: "lateRepay" | "onTimeRepay" | "earlyRepay";
      borrower: string;
      lender: string;
      asset: string;
      orderId: bigint;
      assertUsersAfter?: string[];
    }
  | {
      type: "applyLiquidationPenalty";
      actor: string;
      assertUsersAfter?: string[];
    }
  | {
      type: "applyManualPenalty";
      actor: string;
      amount: bigint;
      assertUsersAfter?: string[];
    }
  | {
      type: "checkpoint";
      label: string;
      users: string[];
    };

export type RewardCommandScenario = {
  id: string;
  title: string;
  liveIntent: string;
  commands: RewardCommand[];
};

export type RewardCommandModelEnv = {
  resolveActor(actor: string): string;
  resolveAsset(asset: string): string;
  getAmountValue18(assetAddress: string, amountBaseUnits: bigint): Promise<bigint>;
  setLevelMultiplier(level: bigint, multiplierBps: bigint): Promise<void>;
  setDynamicRewardParams(thresholdEasy: bigint, dynamicMultiplierBps: bigint): Promise<void>;
  setLatePenaltyBps(latePenaltyBps: bigint): Promise<void>;
  setLiquidationPenaltyBps(liquidationPenaltyBps: bigint): Promise<void>;
  updateUserLevel(userAddress: string, level: bigint): Promise<void>;
  onLoanEventByOrderWithLender(params: {
    borrowerAddress: string;
    lenderAddress: string;
    assetAddress: string;
    orderId: bigint;
    amountBaseUnits: bigint;
    maturity: bigint;
    outcome: number;
  }): Promise<void>;
  quoteLiquidationPenalty?(userAddress: string): Promise<bigint>;
  applyLiquidationPenalty(userAddress: string): Promise<void>;
  applyManualPenalty(userAddress: string, amount: bigint): Promise<void>;
  readUserState(userAddress: string): Promise<RewardObservedUserState>;
};

type RewardModelUserState = RewardObservedUserState;

type RewardModelOrder = {
  borrower: string;
  lender: string;
  asset: string;
  amountBaseUnits: bigint;
  maturity: bigint;
  lockedEasyAmount: bigint;
  settled: boolean;
};

type RewardModelState = {
  users: Map<string, RewardModelUserState>;
  orders: Map<bigint, RewardModelOrder>;
  levelMultipliers: Map<bigint, bigint>;
  dynamicThresholdEasy: bigint;
  dynamicMultiplierBps: bigint;
  latePenaltyBps: bigint;
  liquidationPenaltyBps: bigint;
};

function makeEmptyUserState(): RewardModelUserState {
  return {
    easyBalance: 0n,
    penaltyDebt: 0n,
    pendingPenalty: 0n,
    level: 0n,
    lockedEasy: 0n,
    eligibleLoanCount: 0n,
    onTimeRepayCount: 0n,
    totalBurned: 0n,
  };
}

function getUserState(model: RewardModelState, userAddress: string): RewardModelUserState {
  const existing = model.users.get(userAddress);
  if (existing) {
    return existing;
  }
  const created = makeEmptyUserState();
  model.users.set(userAddress, created);
  return created;
}

function syncPendingPenalty(user: RewardModelUserState) {
  user.pendingPenalty = user.penaltyDebt;
}

function getLevelMultiplierBps(model: RewardModelState, level: bigint) {
  return model.levelMultipliers.get(level) ?? 10_000n;
}

export function computeLockedEasy(params: {
  levelMultiplierBps: bigint;
  dynamicThresholdEasy: bigint;
  dynamicMultiplierBps: bigint;
}) {
  let lockedEasy = (ONE_EASY * params.levelMultiplierBps) / 10_000n;
  if (lockedEasy === 0n) {
    lockedEasy = ONE_EASY;
  }
  if (
    params.dynamicMultiplierBps !== 0n
    && params.dynamicThresholdEasy !== 0n
    && lockedEasy >= params.dynamicThresholdEasy
  ) {
    lockedEasy += (lockedEasy * params.dynamicMultiplierBps) / 10_000n;
  }
  return lockedEasy;
}

export function normalizeToSystemValue18(amountBaseUnits: bigint, price: bigint, assetDecimals: bigint) {
  if (amountBaseUnits === 0n || price === 0n || assetDecimals <= 0n) {
    return 0n;
  }

  const assetValue = (amountBaseUnits * price) / 10n ** assetDecimals;
  if (assetDecimals === 18n) {
    return assetValue;
  }
  if (assetDecimals < 18n) {
    return assetValue * 10n ** (18n - assetDecimals);
  }
  return assetValue / 10n ** (assetDecimals - 18n);
}

export function expectedSharesFromAmountValue18(amountValue18: bigint) {
  const netValue18 = (amountValue18 * 9970n) / 10_000n;
  const expectedMint = (netValue18 * 10n) / 1000n;
  const borrowerShare = expectedMint / 2n;
  const lenderShare = expectedMint - borrowerShare;
  return {
    expectedMint,
    borrowerShare,
    lenderShare,
  };
}

export function offsetAgainstDebt(pendingDebt: bigint, rewardAmount: bigint) {
  if (rewardAmount >= pendingDebt) {
    return {
      netReward: rewardAmount - pendingDebt,
      remainingDebt: 0n,
    };
  }

  return {
    netReward: 0n,
    remainingDebt: pendingDebt - rewardAmount,
  };
}

export function settleBorrowerOnTimeDebt(params: {
  pendingDebtBeforeUnlock: bigint;
  unlockedEasyAmount: bigint;
  mintedShare: bigint;
}) {
  const debtAfterUnlockOffset = params.pendingDebtBeforeUnlock > params.unlockedEasyAmount
    ? params.pendingDebtBeforeUnlock - params.unlockedEasyAmount
    : 0n;
  const emissionOffset = offsetAgainstDebt(debtAfterUnlockOffset, params.mintedShare);
  return {
    unlockOffsetUsed: params.pendingDebtBeforeUnlock - debtAfterUnlockOffset,
    netReward: emissionOffset.netReward,
    remainingDebt: emissionOffset.remainingDebt,
  };
}

function makeModelState(): RewardModelState {
  return {
    users: new Map<string, RewardModelUserState>(),
    orders: new Map<bigint, RewardModelOrder>(),
    levelMultipliers: new Map<bigint, bigint>(),
    dynamicThresholdEasy: 0n,
    dynamicMultiplierBps: 0n,
    latePenaltyBps: 0n,
    liquidationPenaltyBps: 0n,
  };
}

function getAssertUsers(command: RewardCommand) {
  if (command.type === "checkpoint") {
    return command.users;
  }
  if ("assertUsersAfter" in command && command.assertUsersAfter) {
    return command.assertUsersAfter;
  }
  return [] as string[];
}

async function assertUsersMatchModel(
  scenario: RewardCommandScenario,
  command: RewardCommand,
  env: RewardCommandModelEnv,
  model: RewardModelState,
  actorKeys: string[],
) {
  for (const actorKey of actorKeys) {
    const userAddress = env.resolveActor(actorKey);
    const expected = getUserState(model, userAddress);
    const actual = await env.readUserState(userAddress);
    const checks: Array<keyof RewardObservedUserState> = [
      "easyBalance",
      "penaltyDebt",
      "pendingPenalty",
      "level",
      "lockedEasy",
      "eligibleLoanCount",
      "onTimeRepayCount",
      "totalBurned",
    ];

    for (const key of checks) {
      if (actual[key] !== expected[key]) {
        throw new Error(
          `${scenario.id}:${command.type}:${actorKey} ${String(key)} mismatch actual=${actual[key].toString()} expected=${expected[key].toString()}`,
        );
      }
    }
  }
}

async function executeBorrow(command: Extract<RewardCommand, { type: "borrow" }>, env: RewardCommandModelEnv, model: RewardModelState) {
  const borrowerAddress = env.resolveActor(command.borrower);
  const lenderAddress = env.resolveActor(command.lender);
  const assetAddress = env.resolveAsset(command.asset);
  const borrower = getUserState(model, borrowerAddress);
  const lockedEasyAmount = computeLockedEasy({
    levelMultiplierBps: getLevelMultiplierBps(model, borrower.level),
    dynamicThresholdEasy: model.dynamicThresholdEasy,
    dynamicMultiplierBps: model.dynamicMultiplierBps,
  });

  await env.onLoanEventByOrderWithLender({
    borrowerAddress,
    lenderAddress,
    assetAddress,
    orderId: command.orderId,
    amountBaseUnits: command.amountBaseUnits,
    maturity: command.maturity,
    outcome: 0,
  });

  borrower.lockedEasy += lockedEasyAmount;
  borrower.eligibleLoanCount += 1n;
  syncPendingPenalty(borrower);
  getUserState(model, lenderAddress);
  model.orders.set(command.orderId, {
    borrower: borrowerAddress,
    lender: lenderAddress,
    asset: assetAddress,
    amountBaseUnits: command.amountBaseUnits,
    maturity: command.maturity,
    lockedEasyAmount,
    settled: false,
  });
}

async function executeRepay(
  command: Extract<RewardCommand, { type: "lateRepay" | "onTimeRepay" | "earlyRepay" }>,
  env: RewardCommandModelEnv,
  model: RewardModelState,
) {
  const borrowerAddress = env.resolveActor(command.borrower);
  const lenderAddress = env.resolveActor(command.lender);
  const order = model.orders.get(command.orderId);
  if (!order) {
    throw new Error(`missing modeled order ${command.orderId.toString()} for ${command.type}`);
  }
  if (order.settled) {
    throw new Error(`order ${command.orderId.toString()} already settled in model`);
  }
  if (order.borrower !== borrowerAddress || order.lender !== lenderAddress) {
    throw new Error(`order ${command.orderId.toString()} actor mismatch for ${command.type}`);
  }

  const outcome = command.type === "lateRepay" ? 3 : command.type === "earlyRepay" ? 2 : 1;
  await env.onLoanEventByOrderWithLender({
    borrowerAddress,
    lenderAddress,
    assetAddress: order.asset,
    orderId: command.orderId,
    amountBaseUnits: order.amountBaseUnits,
    maturity: order.maturity,
    outcome,
  });

  const amountValue18 = await env.getAmountValue18(order.asset, order.amountBaseUnits);
  const { borrowerShare, lenderShare } = expectedSharesFromAmountValue18(amountValue18);
  const borrower = getUserState(model, borrowerAddress);
  const lender = getUserState(model, lenderAddress);

  if (command.type === "lateRepay") {
    borrower.penaltyDebt += (order.lockedEasyAmount * model.latePenaltyBps) / 10_000n;
    const borrowerOffset = offsetAgainstDebt(borrower.penaltyDebt, borrowerShare);
    borrower.penaltyDebt = borrowerOffset.remainingDebt;
    borrower.easyBalance += borrowerOffset.netReward;

    const lenderOffset = offsetAgainstDebt(lender.penaltyDebt, lenderShare);
    lender.penaltyDebt = lenderOffset.remainingDebt;
    lender.easyBalance += lenderOffset.netReward;
  } else {
    const borrowerSettlement = settleBorrowerOnTimeDebt({
      pendingDebtBeforeUnlock: borrower.penaltyDebt,
      unlockedEasyAmount: order.lockedEasyAmount,
      mintedShare: borrowerShare,
    });
    borrower.penaltyDebt = borrowerSettlement.remainingDebt;
    borrower.easyBalance += borrowerSettlement.netReward;
    if (command.type === "onTimeRepay") {
      borrower.onTimeRepayCount += 1n;
    }

    const lenderOffset = offsetAgainstDebt(lender.penaltyDebt, lenderShare);
    lender.penaltyDebt = lenderOffset.remainingDebt;
    lender.easyBalance += lenderOffset.netReward;
  }

  borrower.lockedEasy -= order.lockedEasyAmount;
  syncPendingPenalty(borrower);
  syncPendingPenalty(lender);
  order.settled = true;
}

async function executeApplyLiquidationPenalty(
  command: Extract<RewardCommand, { type: "applyLiquidationPenalty" }>,
  env: RewardCommandModelEnv,
  model: RewardModelState,
) {
  const userAddress = env.resolveActor(command.actor);
  const user = getUserState(model, userAddress);
  const expectedPenalty = (user.lockedEasy * model.liquidationPenaltyBps) / 10_000n;

  if (env.quoteLiquidationPenalty) {
    const quoted = await env.quoteLiquidationPenalty(userAddress);
    if (quoted !== expectedPenalty) {
      throw new Error(
        `quoteLiquidationPenalty mismatch actor=${command.actor} actual=${quoted.toString()} expected=${expectedPenalty.toString()}`,
      );
    }
  }

  await env.applyLiquidationPenalty(userAddress);
  user.penaltyDebt += expectedPenalty;
  syncPendingPenalty(user);
}

async function executeApplyManualPenalty(
  command: Extract<RewardCommand, { type: "applyManualPenalty" }>,
  env: RewardCommandModelEnv,
  model: RewardModelState,
) {
  const userAddress = env.resolveActor(command.actor);
  await env.applyManualPenalty(userAddress, command.amount);
  const user = getUserState(model, userAddress);
  user.penaltyDebt += command.amount;
  syncPendingPenalty(user);
}

export async function runRewardCommandScenario(params: {
  scenario: RewardCommandScenario;
  env: RewardCommandModelEnv;
}) {
  const model = makeModelState();

  for (const command of params.scenario.commands) {
    switch (command.type) {
      case "setLevelMultiplier":
        await params.env.setLevelMultiplier(command.level, command.multiplierBps);
        model.levelMultipliers.set(command.level, command.multiplierBps);
        break;
      case "setDynamicRewardParams":
        await params.env.setDynamicRewardParams(command.thresholdEasy, command.dynamicMultiplierBps);
        model.dynamicThresholdEasy = command.thresholdEasy;
        model.dynamicMultiplierBps = command.dynamicMultiplierBps;
        break;
      case "setLatePenaltyBps":
        await params.env.setLatePenaltyBps(command.latePenaltyBps);
        model.latePenaltyBps = command.latePenaltyBps;
        break;
      case "setLiquidationPenaltyBps":
        await params.env.setLiquidationPenaltyBps(command.liquidationPenaltyBps);
        model.liquidationPenaltyBps = command.liquidationPenaltyBps;
        break;
      case "updateUserLevel": {
        const userAddress = params.env.resolveActor(command.actor);
        await params.env.updateUserLevel(userAddress, command.level);
        getUserState(model, userAddress).level = command.level;
        break;
      }
      case "borrow":
        await executeBorrow(command, params.env, model);
        break;
      case "lateRepay":
      case "onTimeRepay":
      case "earlyRepay":
        await executeRepay(command, params.env, model);
        break;
      case "applyLiquidationPenalty":
        await executeApplyLiquidationPenalty(command, params.env, model);
        break;
      case "applyManualPenalty":
        await executeApplyManualPenalty(command, params.env, model);
        break;
      case "checkpoint":
        break;
      default:
        throw new Error(`unsupported command ${(command as RewardCommand).type}`);
    }

    await assertUsersMatchModel(params.scenario, command, params.env, model, getAssertUsers(command));
  }

  return model;
}

export function buildConcurrentPenaltyOffsetScenario(params: {
  asset: string;
  amountBaseUnits: bigint;
  maturity: bigint;
  orderIdBase?: bigint;
}) : RewardCommandScenario {
  const orderIdBase = params.orderIdBase ?? 100n;

  return {
    id: "reward-concurrent-penalty-offset-sequence",
    title: "tracks concurrent lockedEasy and borrower/lender penalty conservation across sequential settlements",
    liveIntent: "multi-user concurrent reward accumulation with borrower/lender penalty offset convergence",
    commands: [
      { type: "setLevelMultiplier", level: 1n, multiplierBps: 10_000n },
      { type: "setLevelMultiplier", level: 2n, multiplierBps: 15_000n },
      { type: "setLevelMultiplier", level: 3n, multiplierBps: 20_000n },
      { type: "setDynamicRewardParams", thresholdEasy: ONE_EASY, dynamicMultiplierBps: 2000n },
      { type: "setLatePenaltyBps", latePenaltyBps: 500n },
      { type: "setLiquidationPenaltyBps", liquidationPenaltyBps: 10_000n },
      { type: "updateUserLevel", actor: "borrowerAlice", level: 3n },
      { type: "updateUserLevel", actor: "borrowerBob", level: 2n },
      {
        type: "borrow",
        borrower: "borrowerAlice",
        lender: "lenderCarol",
        asset: params.asset,
        orderId: orderIdBase + 1n,
        amountBaseUnits: params.amountBaseUnits,
        maturity: params.maturity,
      },
      {
        type: "borrow",
        borrower: "borrowerAlice",
        lender: "lenderCarol",
        asset: params.asset,
        orderId: orderIdBase + 2n,
        amountBaseUnits: params.amountBaseUnits,
        maturity: params.maturity,
      },
      {
        type: "borrow",
        borrower: "borrowerBob",
        lender: "lenderDave",
        asset: params.asset,
        orderId: orderIdBase + 3n,
        amountBaseUnits: params.amountBaseUnits,
        maturity: params.maturity,
        assertUsersAfter: ["borrowerAlice", "borrowerBob"],
      },
      {
        type: "applyLiquidationPenalty",
        actor: "borrowerAlice",
        assertUsersAfter: ["borrowerAlice"],
      },
      {
        type: "applyManualPenalty",
        actor: "borrowerAlice",
        amount: ONE_EASY,
        assertUsersAfter: ["borrowerAlice"],
      },
      {
        type: "applyManualPenalty",
        actor: "lenderCarol",
        amount: 7n * ONE_EASY,
        assertUsersAfter: ["lenderCarol"],
      },
      {
        type: "applyManualPenalty",
        actor: "lenderDave",
        amount: ONE_EASY / 2n,
        assertUsersAfter: ["lenderDave"],
      },
      {
        type: "lateRepay",
        borrower: "borrowerAlice",
        lender: "lenderCarol",
        asset: params.asset,
        orderId: orderIdBase + 1n,
        assertUsersAfter: ["borrowerAlice", "lenderCarol", "borrowerBob", "lenderDave"],
      },
      {
        type: "onTimeRepay",
        borrower: "borrowerAlice",
        lender: "lenderCarol",
        asset: params.asset,
        orderId: orderIdBase + 2n,
        assertUsersAfter: ["borrowerAlice", "lenderCarol"],
      },
      {
        type: "onTimeRepay",
        borrower: "borrowerBob",
        lender: "lenderDave",
        asset: params.asset,
        orderId: orderIdBase + 3n,
        assertUsersAfter: ["borrowerAlice", "lenderCarol", "borrowerBob", "lenderDave"],
      },
      {
        type: "checkpoint",
        label: "final-concurrent-offset-state",
        users: ["borrowerAlice", "lenderCarol", "borrowerBob", "lenderDave"],
      },
    ],
  };
}

export function buildInterleavedPenaltyLiquidationScenario(params: {
  asset: string;
  amountBaseUnits: bigint;
  maturity: bigint;
  orderIdBase?: bigint;
}) : RewardCommandScenario {
  const orderIdBase = params.orderIdBase ?? 300n;

  return {
    id: "reward-interleaved-late-liquidation-sequence",
    title: "handles interleaved late penalty and liquidation penalty across a long multi-mint offset sequence",
    liveIntent: "interleaved liquidation, late-penalty, and recovery sequence with final penalty convergence",
    commands: [
      { type: "setLevelMultiplier", level: 1n, multiplierBps: 10_000n },
      { type: "setLevelMultiplier", level: 3n, multiplierBps: 20_000n },
      { type: "setDynamicRewardParams", thresholdEasy: ONE_EASY, dynamicMultiplierBps: 2000n },
      { type: "setLatePenaltyBps", latePenaltyBps: 500n },
      { type: "setLiquidationPenaltyBps", liquidationPenaltyBps: 5000n },
      { type: "updateUserLevel", actor: "borrowerAlice", level: 3n },
      {
        type: "borrow",
        borrower: "borrowerAlice",
        lender: "lenderCarol",
        asset: params.asset,
        orderId: orderIdBase + 1n,
        amountBaseUnits: params.amountBaseUnits,
        maturity: params.maturity,
      },
      {
        type: "borrow",
        borrower: "borrowerAlice",
        lender: "lenderCarol",
        asset: params.asset,
        orderId: orderIdBase + 2n,
        amountBaseUnits: params.amountBaseUnits,
        maturity: params.maturity,
      },
      {
        type: "borrow",
        borrower: "borrowerAlice",
        lender: "lenderCarol",
        asset: params.asset,
        orderId: orderIdBase + 3n,
        amountBaseUnits: params.amountBaseUnits,
        maturity: params.maturity,
        assertUsersAfter: ["borrowerAlice"],
      },
      {
        type: "applyLiquidationPenalty",
        actor: "borrowerAlice",
        assertUsersAfter: ["borrowerAlice"],
      },
      {
        type: "applyManualPenalty",
        actor: "lenderCarol",
        amount: 8n * ONE_EASY,
        assertUsersAfter: ["lenderCarol"],
      },
      {
        type: "lateRepay",
        borrower: "borrowerAlice",
        lender: "lenderCarol",
        asset: params.asset,
        orderId: orderIdBase + 1n,
        assertUsersAfter: ["borrowerAlice", "lenderCarol"],
      },
      {
        type: "applyLiquidationPenalty",
        actor: "borrowerAlice",
        assertUsersAfter: ["borrowerAlice"],
      },
      {
        type: "onTimeRepay",
        borrower: "borrowerAlice",
        lender: "lenderCarol",
        asset: params.asset,
        orderId: orderIdBase + 2n,
        assertUsersAfter: ["borrowerAlice", "lenderCarol"],
      },
      {
        type: "applyManualPenalty",
        actor: "borrowerAlice",
        amount: ONE_EASY,
        assertUsersAfter: ["borrowerAlice"],
      },
      {
        type: "applyManualPenalty",
        actor: "lenderCarol",
        amount: 7n * 10n ** 17n,
        assertUsersAfter: ["lenderCarol"],
      },
      {
        type: "lateRepay",
        borrower: "borrowerAlice",
        lender: "lenderCarol",
        asset: params.asset,
        orderId: orderIdBase + 3n,
        assertUsersAfter: ["borrowerAlice", "lenderCarol"],
      },
      {
        type: "checkpoint",
        label: "final-interleaved-penalty-state",
        users: ["borrowerAlice", "lenderCarol"],
      },
    ],
  };
}

export const REWARD_LONG_SEQUENCE_CATALOG = [
  {
    id: "reward-concurrent-penalty-offset-sequence",
    title: "concurrent penalty offset sequence",
    liveIntent: "multi-user concurrent reward accumulation with borrower/lender penalty offset convergence",
    mappedLiveCase: "live-reward-multi-borrower-stress",
  },
  {
    id: "reward-interleaved-late-liquidation-sequence",
    title: "interleaved liquidation penalty sequence",
    liveIntent: "interleaved liquidation, late-penalty, and recovery sequence with final penalty convergence",
    mappedLiveCase: "live-reward-penalty-recycle-recovery",
  },
] as const;