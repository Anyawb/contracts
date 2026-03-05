import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost.ts";

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function assertOk(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  const [deployer] = await ethers.getSigners();

  const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
  const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;

  const monAddr = CONTRACT_ADDRESSES.DegradationMonitor;
  const coreAddr = CONTRACT_ADDRESSES.DegradationCore;
  const storageAddr = CONTRACT_ADDRESSES.DegradationStorage;

  assertOk(monAddr && coreAddr && storageAddr, "missing degradation addresses in contracts-localhost.ts (deploy:localhost first)");

  const monitor = (await ethers.getContractAt(
    "src/monitor/DegradationMonitor.sol:DegradationMonitor",
    monAddr
  )) as any;
  const core = (await ethers.getContractAt("src/monitor/DegradationCore.sol:DegradationCore", coreAddr)) as any;
  const storage = (await ethers.getContractAt("src/monitor/DegradationStorage.sol:DegradationStorage", storageAddr)) as any;

  // Ensure caller is authorized to read monitor APIs.
  // (deploy:localhost already grants ACTION_ADMIN + ACTION_VIEW_SYSTEM_STATUS to deployer)
  for (const r of [key("ACTION_ADMIN"), key("ACTION_VIEW_SYSTEM_STATUS")]) {
    if (!(await acm.hasRole(r, deployer.address))) {
      await acm.grantRole(r, deployer.address);
    }
  }

  // Make sure monitor is correctly bound in Registry (required for monitor->core/storage internal reads).
  const bound = await registry.getModule(key("DEGRADATION_MONITOR"));
  if (String(bound).toLowerCase() !== String(monAddr).toLowerCase()) {
    throw new Error(`Registry KEY_DEGRADATION_MONITOR mismatch: expected=${monAddr} got=${bound}`);
  }

  // Baseline core stats (lifetime) for dirty-chain robustness.
  const baseStats = await core.getDegradationStats();
  const baseTotal = BigInt(baseStats.totalDegradations);
  const baseFallbackSum = BigInt(baseStats.totalFallbackValue);

  // Mine ahead so "recent window" (ViewConstants.CACHE_DURATION_BLOCKS=150) can be tested.
  await ethers.provider.send("hardhat_mine", [ethers.toBeHex(200)]);
  const cur = BigInt(await ethers.provider.getBlockNumber());
  const oldBlock = cur - 151n;

  const moduleA = ethers.Wallet.createRandom().address;
  const moduleB = ethers.Wallet.createRandom().address;

  // Use DegradationMonitor as the write-path coordinator (SSOT).
  const reasonBOld1 = "REASON_B_OLD_1";
  const reasonAOld = "REASON_A_OLD";
  const reasonBRecent = "REASON_B_RECENT";
  const reasonBOld1Hash = ethers.keccak256(ethers.toUtf8Bytes(reasonBOld1));
  const reasonAOldHash = ethers.keccak256(ethers.toUtf8Bytes(reasonAOld));
  const reasonBRecentHash = ethers.keccak256(ethers.toUtf8Bytes(reasonBRecent));

  // Create "old" events, then mine beyond the recent window, then create a "recent" event.
  await monitor.connect(deployer).recordDegradationEvent(moduleB, reasonBOld1, 10n, true);
  await monitor.connect(deployer).recordDegradationEvent(moduleA, reasonAOld, 20n, true);

  // Advance so the first two events are outside the recent window (ViewConstants.CACHE_DURATION_BLOCKS=150).
  await ethers.provider.send("hardhat_mine", [ethers.toBeHex(200)]);

  await monitor.connect(deployer).recordDegradationEvent(moduleB, reasonBRecent, 1n, true);

  const [total, recent, mostFrequent, avg] = await monitor.connect(deployer).getSystemDegradationTrends();

  // Expectations for Scheme A fallback (dirty-chain safe):
  // - total/avg from Core lifetime stats (baseline + new events).
  // - recent/mostFrequent from Storage window scan (only assert our injected event is present).
  const newFallbackSum = 31n; // 10 + 20 + 1
  const expectedTotal = baseTotal + 3n;
  const expectedAvg = (baseFallbackSum + newFallbackSum) / expectedTotal;
  assertOk(total === expectedTotal, `expected totalEvents=${expectedTotal} (core), got ${total}`);
  assertOk(avg === expectedAvg, `expected averageFallbackValue=${expectedAvg} (core), got ${avg}`);
  assertOk(recent >= 1n, `expected recentEvents >= 1 (storage recent window), got ${recent}`);

  // Verify our recent event exists in storage and is within the recent window.
  const [, actualCount] = await storage.getCircularBufferStats();
  const recentWindowBlocks = 150n;
  const curBlock = BigInt(await ethers.provider.getBlockNumber());
  const minRecentBlock = curBlock > recentWindowBlocks ? curBlock - recentWindowBlocks : 0n;
  let foundRecent = false;
  for (let i = 0; i < Number(actualCount); i++) {
    const evt = await storage.getEventFromCircularBuffer(i);
    const mod = String(evt.module).toLowerCase();
    const rh = String(evt.reasonHash).toLowerCase();
    if (mod === moduleB.toLowerCase() && rh === reasonBRecentHash.toLowerCase()) {
      if (BigInt(evt.blockNumber) >= minRecentBlock) foundRecent = true;
    }
  }
  assertOk(foundRecent, "expected recent event for moduleB to be within recent window");

  console.log("✅ DegradationMonitor trends (Scheme A fallback) acceptance passed");
  console.log("   totalEvents:", total.toString());
  console.log("   recentEvents:", recent.toString());
  console.log("   mostFrequentModule:", mostFrequent);
  console.log("   averageFallbackValue:", avg.toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

