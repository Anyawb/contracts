import * as fs from "node:fs";
import * as path from "node:path";
import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../../frontend-config/contracts-localhost.ts";

const PUSH_FAILED_IFACE = new ethers.Interface([
  "event RewardViewPushFailed(address indexed user, address indexed rewardView, bytes32 indexed op, bytes payload, bytes reason)",
]);
const REWARD_VIEW_OP_PENALTY_LEDGER = ethers.keccak256(ethers.toUtf8Bytes("PENALTY_LEDGER"));
const REWARD_VIEW_PUSH_FAILED_TOPIC0 = ethers.id(
  "RewardViewPushFailed(address,address,bytes32,bytes,bytes)"
);
const REWARD_VIEW_UNAVAILABLE_REASON_HEX = ethers.hexlify(ethers.toUtf8Bytes("rewardView unavailable")).toLowerCase();

function key(name: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readArg(name: string): string | undefined {
  const index = process.argv.findIndex((value) => value === name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function parseBlock(value: string | undefined, fallback?: bigint): bigint | undefined {
  if (!value || value.length === 0) return fallback;
  return BigInt(value);
}

function readJson(filePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

type ReplayCandidate = {
  payloadUser: string;
  pendingDebt: bigint;
  payloadBlockNumber: bigint;
  emittedBlockNumber: bigint;
  transactionHash: string;
  rewardView: string;
  reasonHex: string;
  logIndex: number;
  source: string;
};

function decodePenaltyPayload(payload: string): { user: string; pendingDebt: bigint; blockNumber: bigint } {
  const [user, pendingDebt, blockNumber] = ethers.AbiCoder.defaultAbiCoder().decode(
    ["address", "uint256", "uint256"],
    payload
  ) as unknown as [string, bigint, bigint];
  return { user, pendingDebt, blockNumber };
}

async function main() {
  const [admin] = await ethers.getSigners();
  const provider = ethers.provider;
  const currentBlock = BigInt(await provider.getBlockNumber());
  const dryRun = hasFlag("--dry-run") || process.env.REWARDVIEW_REPLAY_DRY_RUN === "1";

  const fromBlock = parseBlock(readArg("--from-block") ?? process.env.REWARDVIEW_REPLAY_FROM_BLOCK, currentBlock > 50_000n ? currentBlock - 50_000n : 0n) ?? 0n;
  const toBlock = parseBlock(readArg("--to-block") ?? process.env.REWARDVIEW_REPLAY_TO_BLOCK, currentBlock) ?? currentBlock;
  const artifactArg = readArg("--artifact") ?? process.env.REWARDVIEW_REPLAY_ARTIFACT;
  const registryAddr = process.env.REGISTRY_ADDR ?? CONTRACT_ADDRESSES.Registry;

  const registry = (await ethers.getContractAt("Registry", registryAddr)) as any;
  const rewardViewAddr = (await registry.getModuleOrRevert(key("REWARD_VIEW"))) as string;
  const rewardAccrualManagerAddr = (await registry.getModuleOrRevert(key("REWARD_ACCRUAL_MANAGER"))) as string;
  const rewardView = (await ethers.getContractAt("RewardView", rewardViewAddr)) as any;
  const rewardAccrualManager = (await ethers.getContractAt("RewardAccrualManager", rewardAccrualManagerAddr)) as any;

  const latestByUser = new Map<string, ReplayCandidate>();

  const upsertCandidate = (candidate: ReplayCandidate) => {
    const userKey = candidate.payloadUser.toLowerCase();
    const previous = latestByUser.get(userKey);
    if (
      !previous ||
      candidate.emittedBlockNumber > previous.emittedBlockNumber ||
      (candidate.emittedBlockNumber === previous.emittedBlockNumber && candidate.logIndex > previous.logIndex)
    ) {
      latestByUser.set(userKey, candidate);
    }
  };

  let logs: any[] = [];
  if (!artifactArg) {
    logs = await provider.getLogs({
      address: rewardAccrualManagerAddr,
      fromBlock: ethers.toBeHex(fromBlock),
      toBlock: ethers.toBeHex(toBlock),
      topics: [
        REWARD_VIEW_PUSH_FAILED_TOPIC0,
        null,
        null,
        ethers.zeroPadValue(REWARD_VIEW_OP_PENALTY_LEDGER, 32),
      ],
    });

    for (const log of logs) {
      const parsed = PUSH_FAILED_IFACE.parseLog({ topics: log.topics as string[], data: log.data });
      if (!parsed) continue;

      const payload = decodePenaltyPayload(String(parsed.args.payload));
      const reasonHex = ethers.hexlify(ethers.getBytes(parsed.args.reason)).toLowerCase();
      upsertCandidate({
        payloadUser: payload.user,
        pendingDebt: payload.pendingDebt,
        payloadBlockNumber: payload.blockNumber,
        emittedBlockNumber: BigInt(log.blockNumber),
        transactionHash: String(log.transactionHash),
        rewardView: String(parsed.args.rewardView),
        reasonHex,
        logIndex: log.index,
        source: "logs",
      });
    }
  } else {
    const artifact = readJson(path.resolve(artifactArg));
    const bestEffort = artifact?.rewardExtendedChecks?.missingRewardViewBestEffort;
    const delayed = bestEffort?.afterCacheRollover;
    if (
      bestEffort?.skipped === false
      && typeof delayed?.user === "string"
      && delayed.user.length > 0
      && delayed?.penaltyDebtAfter !== undefined
      && delayed?.blockNumber !== undefined
    ) {
      upsertCandidate({
        payloadUser: delayed.user,
        pendingDebt: BigInt(String(delayed.penaltyDebtAfter)),
        payloadBlockNumber: BigInt(String(delayed.blockNumber)),
        emittedBlockNumber: BigInt(String(delayed.blockNumber)),
        transactionHash: String(delayed.txHash ?? bestEffort.txHash ?? "artifact-derived"),
        rewardView: String(bestEffort.unavailableRewardView ?? bestEffort.rewardView ?? rewardViewAddr),
        reasonHex: String(delayed.lastFailureReason ?? bestEffort.reasonHex ?? "").toLowerCase(),
        logIndex: 0,
        source: path.resolve(artifactArg),
      });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    registry: registryAddr,
    rewardView: rewardViewAddr,
    rewardAccrualManager: rewardAccrualManagerAddr,
    admin: admin.address,
    dryRun,
    source: artifactArg ? path.resolve(artifactArg) : "logs",
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    scannedLogs: logs.length,
    candidates: [] as Array<Record<string, string | boolean>>,
  };

  for (const entry of latestByUser.values()) {
    const authoritativePenalty = (await rewardAccrualManager.getPenaltyDebt(entry.payloadUser)) as bigint;
    const rewardSummary = (await rewardView.getUserRewardSummaryWithMeta(entry.payloadUser)) as [bigint, bigint, number, bigint, bigint, boolean];
    const mirroredPenalty = rewardSummary[1] as bigint;
    const viewAlreadyAligned = mirroredPenalty === authoritativePenalty;
    const payloadStillCurrent = authoritativePenalty === entry.pendingDebt;
    const canReplay = !viewAlreadyAligned && payloadStillCurrent && entry.reasonHex === REWARD_VIEW_UNAVAILABLE_REASON_HEX;

    if (canReplay && !dryRun) {
      const tx = await rewardView
        .connect(admin)
        .retryPushPenaltyLedger(entry.payloadUser, authoritativePenalty, entry.payloadBlockNumber);
      const receipt = await tx.wait();
      report.candidates.push({
        user: entry.payloadUser,
        txHash: entry.transactionHash,
        replayed: true,
        replayTxHash: String(receipt?.hash ?? tx.hash),
        authoritativePenalty: authoritativePenalty.toString(),
        mirroredPenaltyBefore: mirroredPenalty.toString(),
        reasonHex: entry.reasonHex,
      });
      continue;
    }

    report.candidates.push({
      user: entry.payloadUser,
      txHash: entry.transactionHash,
      replayed: false,
      skippedReason: viewAlreadyAligned
        ? "already-aligned"
        : !payloadStillCurrent
          ? "stale-payload"
          : entry.reasonHex !== REWARD_VIEW_UNAVAILABLE_REASON_HEX
            ? "unexpected-failure-reason"
            : dryRun
              ? "dry-run"
              : "unknown",
      authoritativePenalty: authoritativePenalty.toString(),
      mirroredPenaltyBefore: mirroredPenalty.toString(),
      payloadPenalty: entry.pendingDebt.toString(),
      reasonHex: entry.reasonHex,
    });
  }

  const outDir = path.join(__dirname, "..", "artifacts");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `rewardview-penalty-replay.${Date.now()}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify(report, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2) + "\n",
    "utf8"
  );

  console.log(`[RewardViewReplay] scanned=${logs.length} candidates=${report.candidates.length} dryRun=${dryRun}`);
  console.log(`[RewardViewReplay] report=${outPath}`);
}

main().catch((error) => {
  console.error("[RewardViewReplay] failed");
  console.error(error);
  process.exit(1);
});