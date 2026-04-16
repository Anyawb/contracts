import { ethers } from "hardhat";
import type { Interface, LogDescription } from "ethers";

import { observeExtendedViews, type FundsFlowLiveContext } from "./_fundsFlowLive";

const DATA_TYPE_FEE_DISTRIBUTED = ethers.keccak256(ethers.toUtf8Bytes("FEE_DISTRIBUTED"));
const DATA_TYPE_USER_FEE = ethers.keccak256(ethers.toUtf8Bytes("USER_FEE"));

export function expectBigintEq(label: string, actual: bigint, expected: bigint) {
  if (actual !== expected) {
    throw new Error(`${label}: expected=${expected.toString()} actual=${actual.toString()}`);
  }
}

export function calcFee(amount: bigint, bps: bigint) {
  return (amount * bps) / 10_000n;
}

export function calcRevenueSplit(amount: bigint, platformBps: bigint, ecoBps: bigint) {
  const totalBps = platformBps + ecoBps;
  if (totalBps === 0n) {
    throw new Error("platformBps + ecoBps must be non-zero for prepaid split");
  }
  const platformWeightBps = (platformBps * 10_000n) / totalBps;
  const platformAmt = calcFee(amount, platformWeightBps);
  const ecoAmt = amount - platformAmt;
  return { platformAmt, ecoAmt };
}

export function sumBalancesForGroup(balances: Map<string, bigint>, addresses: string[]) {
  let total = 0n;
  for (const address of [...new Set(addresses.filter((value) => value && value !== ethers.ZeroAddress).map((value) => value.toLowerCase()))]) {
    total += balances.get(address) ?? balances.get(ethers.getAddress(address)) ?? 0n;
  }
  return total;
}

export function normalizeBalanceMap(balances: Map<string, bigint>) {
  const normalized = new Map<string, bigint>();
  for (const [address, value] of balances.entries()) {
    normalized.set(address.toLowerCase(), value);
  }
  return normalized;
}

export function normalizeAddress(address: string) {
  return address.toLowerCase();
}

export function addressOverlaps(address: string, others: string[]) {
  const target = normalizeAddress(address);
  return others.some((other) => normalizeAddress(other) === target);
}

export function uniqueRoleAddress(address: string, others: string[]) {
  return !addressOverlaps(address, others);
}

export function requireFeeRouterGate(snapshot: Awaited<ReturnType<typeof observeExtendedViews>>, stage: string) {
  if (!snapshot.feeRouterSync) {
    throw new Error(`${stage}: FeeRouterView sync status is unavailable`);
  }
  if (!snapshot.feeRouterSync.isValid || snapshot.feeRouterSync.needsSync) {
    const message = `${stage}: FeeRouterView is not publish-ready (valid=${snapshot.feeRouterSync.isValid} needsSync=${snapshot.feeRouterSync.needsSync})`;
    throw new Error(message);
  }
  if (!snapshot.feeRouterUser) {
    throw new Error(`${stage}: FeeRouterView user stats are unavailable`);
  }
  return true;
}

export function assertRoleBasedNetDeltas(args: {
  stage: string;
  beforeBalances: Map<string, bigint>;
  afterBalances: Map<string, bigint>;
  roleDeltas: Array<{ label: string; address: string; expectedDelta: bigint }>;
}) {
  const { stage, beforeBalances, afterBalances, roleDeltas } = args;
  const expectedByAddress = new Map<string, bigint>();

  for (const role of roleDeltas) {
    const key = normalizeAddress(role.address);
    expectedByAddress.set(key, (expectedByAddress.get(key) ?? 0n) + role.expectedDelta);
  }

  for (const [address, expectedDelta] of expectedByAddress.entries()) {
    const before = beforeBalances.get(address) ?? 0n;
    const after = afterBalances.get(address) ?? 0n;
    const actualDelta = after - before;
    if (actualDelta !== expectedDelta) {
      throw new Error(
        `${stage}: address net delta mismatch address=${address} expected=${expectedDelta.toString()} actual=${actualDelta.toString()}`,
      );
    }
  }

  for (const role of roleDeltas) {
    const key = normalizeAddress(role.address);
    const merged = expectedByAddress.get(key) ?? 0n;
    if (merged !== role.expectedDelta) {
      console.log(
        `  [Attribution] ${stage}: merged role delta address=${key} role=${role.label} roleDelta=${role.expectedDelta.toString()} mergedDelta=${merged.toString()}`,
      );
    }
  }
}

export function requireFeeRouterPresence(snapshot: Awaited<ReturnType<typeof observeExtendedViews>>, stage: string) {
  if (!snapshot.feeRouterSync) {
    throw new Error(`${stage}: FeeRouterView sync status is unavailable`);
  }
  if (!snapshot.feeRouterUser) {
    throw new Error(`${stage}: FeeRouterView user stats are unavailable`);
  }
}

export function requireFeeRouterSyncAdvance(
  before: Awaited<ReturnType<typeof observeExtendedViews>>,
  after: Awaited<ReturnType<typeof observeExtendedViews>>,
  stage: string,
) {
  if (!before.feeRouterSync) {
    throw new Error(`${stage}: previous FeeRouterView sync status is unavailable`);
  }
  if (!after.feeRouterSync) {
    throw new Error(`${stage}: current FeeRouterView sync status is unavailable`);
  }
  if (after.feeRouterSync.lastSyncBlock <= before.feeRouterSync.lastSyncBlock) {
    throw new Error(
      `${stage}: FeeRouterView lastSyncBlock did not advance (before=${before.feeRouterSync.lastSyncBlock.toString()} after=${after.feeRouterSync.lastSyncBlock.toString()})`,
    );
  }
}

export async function getFeeGateContracts(ctx: FundsFlowLiveContext) {
  const feeRouter = (await ethers.getContractAt(
    [
      "event FeeRouterViewPushFailed(string kind,address payer,address token,bytes32 feeType,address viewAddr,bytes reason)",
      "event FeeDistributed(address indexed token,uint256 platformAmount,uint256 ecoAmount)",
      "event FeeStatisticsUpdated(address indexed token,bytes32 indexed feeType,uint256 totalAmount)",
      "event DataPushed(bytes32 indexed dataTypeHash, bytes payload)",
      "function getPlatformTreasury() view returns (address)",
      "function getEcosystemVault() view returns (address)",
      "function getPlatformFeeBps() view returns (uint256)",
      "function getEcosystemFeeBps() view returns (uint256)",
      "function getDynamicFee(address token,bytes32 feeType) view returns (uint256)",
      "function distributeNormal(address token,uint256 amount)",
      "function distributePrepaid(address token,uint256 amount,bytes32 feeType,address payer)",
      "function distributeDynamic(address token,uint256 amount,bytes32 feeType)",
      "function setDynamicFee(address token,bytes32 feeType,uint256 feeBps)",
    ],
    ctx.feeRouterAddr,
  )) as any;

  const feeRouterView = ctx.feeRouterView
    ? ((await ethers.getContractAt(
        [
          "event UserDataPushed(address indexed user,string dataType,uint256 blockNumber)",
          "event DataPushed(bytes32 indexed dataTypeHash, bytes payload)",
          "function getSyncStatus() view returns (bool,uint256,bool)",
          "function getUserStatsWithMeta(address user) view returns ((uint256 totalFeePaid,uint256 transactionCount,uint256 lastActivityBlock),uint256,bool)",
          "function getUserFeeStatisticsWithMeta(address user,bytes32 feeType) view returns (uint256,uint256,bool)",
          "function getUserDynamicFeeWithMeta(address user,bytes32 feeType) view returns (uint256,uint256,bool)",
        ],
        ctx.feeRouterView.target,
        ctx.viewer,
      )) as any)
    : null;

  return {
    feeRouter,
    feeRouterView,
  };
}

function parseReceiptLogsForInterface(receipt: any, contractAddr: string, iface: Interface) {
  return (receipt?.logs ?? [])
    .filter((log: any) => String(log?.address ?? "").toLowerCase() === contractAddr.toLowerCase())
    .map((log: any) => {
      try {
        return iface.parseLog({ topics: log.topics, data: log.data });
      } catch {
        return null;
      }
    })
    .filter(Boolean) as LogDescription[];
}

export function assertFeeDistributionReceiptAttribution(args: {
  stage: string;
  receipt: any;
  feeRouter: any;
  feeRouterAddr: string;
  feeRouterView: any;
  feeRouterViewAddr: string;
  token: string;
  feeType: string;
  actor: string;
  user: string;
  totalAmount: bigint;
  distributedAmount: bigint;
  platformAmount: bigint;
  ecoAmount: bigint;
  remainingAmount: bigint;
  appliedFeeBps: bigint;
  expectedPushBlock?: bigint;
  requireFeeRouterViewPush?: boolean;
}) {
  const {
    stage,
    receipt,
    feeRouter,
    feeRouterAddr,
    feeRouterView,
    feeRouterViewAddr,
    token,
    feeType,
    actor,
    user,
    totalAmount,
    distributedAmount,
    platformAmount,
    ecoAmount,
    remainingAmount,
    appliedFeeBps,
    expectedPushBlock,
    requireFeeRouterViewPush = true,
  } = args;

  if (!receipt?.hash) {
    throw new Error(`${stage}: distribution receipt is missing tx hash`);
  }

  const feeRouterLogs = parseReceiptLogsForInterface(receipt, feeRouterAddr, feeRouter.interface);
  const distributionEvent = feeRouterLogs.find((entry) => entry.name === "FeeDistributed");
  if (!distributionEvent) {
    throw new Error(`${stage}: missing FeeRouter FeeDistributed event in tx ${receipt.hash}`);
  }
  if (String(distributionEvent.args.token ?? distributionEvent.args[0]).toLowerCase() !== token.toLowerCase()) {
    throw new Error(`${stage}: FeeDistributed token mismatch in tx ${receipt.hash}`);
  }
  expectBigintEq(
    `${stage} FeeDistributed platformAmount`,
    BigInt(distributionEvent.args.platformAmount ?? distributionEvent.args[1] ?? 0),
    platformAmount,
  );
  expectBigintEq(
    `${stage} FeeDistributed ecoAmount`,
    BigInt(distributionEvent.args.ecoAmount ?? distributionEvent.args[2] ?? 0),
    ecoAmount,
  );

  const feeDistributedPush = feeRouterLogs
    .filter((entry) => entry.name === "DataPushed")
    .find((entry) => String(entry.args[0]).toLowerCase() === DATA_TYPE_FEE_DISTRIBUTED.toLowerCase());
  if (!feeDistributedPush) {
    throw new Error(`${stage}: missing FeeRouter FEE_DISTRIBUTED DataPushed event in tx ${receipt.hash}`);
  }
  const distributedPayload = ethers.AbiCoder.defaultAbiCoder().decode(
    ["address", "uint256", "uint256", "uint256", "bytes32", "uint256", "address", "uint256"],
    feeDistributedPush.args[1],
  );
  if (String(distributedPayload[0]).toLowerCase() !== token.toLowerCase()) {
    throw new Error(`${stage}: FeeRouter DataPushed token mismatch in tx ${receipt.hash}`);
  }
  if (String(distributedPayload[4]).toLowerCase() !== feeType.toLowerCase()) {
    throw new Error(`${stage}: FeeRouter DataPushed feeType mismatch in tx ${receipt.hash}`);
  }
  if (String(distributedPayload[6]).toLowerCase() !== actor.toLowerCase()) {
    throw new Error(`${stage}: FeeRouter DataPushed actor mismatch in tx ${receipt.hash}`);
  }
  expectBigintEq(`${stage} DataPushed platformAmount`, BigInt(distributedPayload[1]), platformAmount);
  expectBigintEq(`${stage} DataPushed ecoAmount`, BigInt(distributedPayload[2]), ecoAmount);
  expectBigintEq(`${stage} DataPushed remainingAmount`, BigInt(distributedPayload[3]), remainingAmount);
  expectBigintEq(`${stage} DataPushed totalAmount`, BigInt(distributedPayload[5]), totalAmount);
  const payloadBlockNumber = BigInt(distributedPayload[7]);
  if (expectedPushBlock !== undefined) {
    expectBigintEq(`${stage} DataPushed blockNumber`, payloadBlockNumber, expectedPushBlock);
  } else if (payloadBlockNumber <= 0n) {
    throw new Error(`${stage}: FeeRouter DataPushed blockNumber must be non-zero in tx ${receipt.hash}`);
  }

  const feeRouterViewLogs = parseReceiptLogsForInterface(receipt, feeRouterViewAddr, feeRouterView.interface);
  const userFeePush = feeRouterViewLogs
    .filter((entry) => entry.name === "DataPushed")
    .find((entry) => String(entry.args[0]).toLowerCase() === DATA_TYPE_USER_FEE.toLowerCase());
  if (!userFeePush) {
    if (!requireFeeRouterViewPush) {
      console.log(`  [Attribution] ${stage}: FeeRouterView USER_FEE DataPushed missing while publish-ready=false; skipping strict view-push attribution`);
      return;
    }
    throw new Error(`${stage}: missing FeeRouterView USER_FEE DataPushed event in tx ${receipt.hash}`);
  }
  const userFeePayload = ethers.AbiCoder.defaultAbiCoder().decode(
    ["address", "bytes32", "uint256", "uint256"],
    userFeePush.args[1],
  );
  if (String(userFeePayload[0]).toLowerCase() !== user.toLowerCase()) {
    throw new Error(`${stage}: FeeRouterView user fee payload user mismatch in tx ${receipt.hash}`);
  }
  if (String(userFeePayload[1]).toLowerCase() !== feeType.toLowerCase()) {
    throw new Error(`${stage}: FeeRouterView user fee payload feeType mismatch in tx ${receipt.hash}`);
  }
  expectBigintEq(`${stage} FeeRouterView user fee payload amount`, BigInt(userFeePayload[2]), distributedAmount);
  expectBigintEq(`${stage} FeeRouterView user fee payload bps`, BigInt(userFeePayload[3]), appliedFeeBps);

  console.log(
    `  [Attribution] ${stage}: tx=${receipt.hash} feeRouterEvent=FeeDistributed feeRouterPush=FEE_DISTRIBUTED feeRouterViewPush=USER_FEE`,
  );
}

export async function readFeeRouterAggregateUserStats(feeRouterView: any, user: string, reader?: any) {
  const target = reader ? feeRouterView.connect(reader) : feeRouterView;
  const [stats, syncBlock, isValid] = (await target.getUserStatsWithMeta(user)) as [
    { totalFeePaid: bigint; transactionCount: bigint; lastActivityBlock: bigint },
    bigint,
    boolean,
  ];
  return {
    totalFeePaid: BigInt(stats.totalFeePaid),
    transactionCount: BigInt(stats.transactionCount),
    lastActivityBlock: BigInt(stats.lastActivityBlock),
    syncBlock: BigInt(syncBlock),
    isValid: Boolean(isValid),
  };
}

function decodeRevertReason(reason: string) {
  const data = reason.toLowerCase().startsWith("0x") ? reason : `0x${reason}`;
  if (data === "0x" || data.length < 10) return data;
  try {
    const selector = data.slice(0, 10).toLowerCase();
    if (selector === "0x08c379a0") {
      const [msg] = ethers.AbiCoder.defaultAbiCoder().decode(["string"], `0x${data.slice(10)}`);
      return `Error(${String(msg)})`;
    }
    if (selector === "0x4e487b71") {
      const [code] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], `0x${data.slice(10)}`);
      return `Panic(${BigInt(code).toString()})`;
    }
  } catch {
    return data;
  }
  return data;
}

export function logFeeRouterViewPushFailures(stage: string, receipt: any, feeRouterInterface: Interface) {
  const event = (() => {
    try {
      return feeRouterInterface.getEvent("FeeRouterViewPushFailed");
    } catch {
      return null;
    }
  })();
  if (!event) {
    console.log(`  [Diag.FeeRouterViewPush] ${stage}: event FeeRouterViewPushFailed is not available in ABI`);
    return;
  }
  const topic = event.topicHash.toLowerCase();
  const failures = (receipt?.logs ?? [])
    .filter((log: any) => String(log?.topics?.[0] ?? "").toLowerCase() === topic)
    .map((log: any) => feeRouterInterface.parseLog({ topics: log.topics, data: log.data }))
    .filter(Boolean);

  if (failures.length === 0) {
    console.log(`  [Diag.FeeRouterViewPush] ${stage}: no push failure events`);
    return;
  }

  for (const item of failures) {
    const kind = String(item.args[0]);
    const payer = String(item.args[1]);
    const token = String(item.args[2]);
    const feeType = String(item.args[3]);
    const viewAddr = String(item.args[4]);
    const reasonHex = ethers.hexlify(item.args[5] as string | Uint8Array);
    console.log(
      `  [Diag.FeeRouterViewPush] ${stage}: kind=${kind} payer=${payer} token=${token} feeType=${feeType} view=${viewAddr} reason=${decodeRevertReason(reasonHex)}`,
    );
  }
}