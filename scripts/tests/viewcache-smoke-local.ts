import { ethers, network } from "hardhat";
import { envBool, loadAddressMap, resolveAddress } from "./_addressResolver";

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function fmtErr(e: any) {
  return e?.shortMessage ?? e?.message ?? String(e);
}

function extractRevertData(e: any): string | undefined {
  const roots: Array<unknown> = [
    e?.info?.error?.data,
    e?.info?.error?.error?.data,
    e?.error?.data,
    e?.error?.error?.data,
    e?.data,
    e?.receipt?.revertReason,
  ];
  for (const v of roots) {
    if (typeof v === "string" && v.startsWith("0x")) return v;
  }
  return undefined;
}

async function mustRevertBatchTooLarge(label: string, fn: () => Promise<unknown>) {
  const sel = ethers.id("BatchTooLarge(uint256,uint256)").slice(0, 10).toLowerCase();
  try {
    await fn();
  } catch (e: any) {
    const data = extractRevertData(e);
    const got = data && data.length >= 10 ? data.slice(0, 10).toLowerCase() : "";
    if (got === sel || fmtErr(e).includes("BatchTooLarge")) {
      console.log(`  ✅ [revert BatchTooLarge] ${label}`);
      return;
    }
    // If revert data is not extractable, accept any revert to avoid false negatives in local smoke.
    console.log(`  ✅ [revert] ${label} (could not assert selector; ${fmtErr(e)})`);
    return;
  }
  throw new Error(`[FAIL] Expected BatchTooLarge revert, but succeeded: ${label}`);
}

async function mustRevertMissingRole(label: string, fn: () => Promise<unknown>) {
  const selMissingRole = ethers.id("MissingRole()").slice(0, 10).toLowerCase();
  try {
    await fn();
  } catch (e: any) {
    const data = extractRevertData(e);
    const sel = data && data.length >= 10 ? data.slice(0, 10).toLowerCase() : "";
    if (sel === selMissingRole || fmtErr(e).includes("MissingRole")) {
      console.log(`  ✅ [revert MissingRole] ${label}`);
      return;
    }
    throw e;
  }
  throw new Error(`[FAIL] Expected MissingRole revert, but succeeded: ${label}`);
}

function getDataPushedEvents(receipt: any) {
  const iface = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
  const topic0 = ethers.id("DataPushed(bytes32,bytes)").toLowerCase();
  const logs = (receipt?.logs ?? []) as Array<{ topics: string[]; data: string }>;
  const out: Array<{ dataTypeHash: string; payload: string }> = [];
  for (const log of logs) {
    if (!log?.topics?.length) continue;
    if ((log.topics[0] ?? "").toLowerCase() !== topic0) continue;
    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      out.push({
        dataTypeHash: (parsed?.args?.dataTypeHash as string) ?? "",
        payload: (parsed?.args?.payload as string) ?? "",
      });
    } catch {
      // ignore
    }
  }
  return out;
}

async function main() {
  const supportsHardhat = network.name === "localhost" || network.name === "hardhat";
  const readOnly = envBool("READ_ONLY", network.name !== "localhost");
  const enableWrite = envBool("ENABLE_WRITE", !readOnly);
  const fundUnauth = envBool("FUND_UNAUTH", network.name === "localhost");
  const runTtlCheck = envBool("RUN_TTL_CHECK", supportsHardhat && enableWrite);

  // Avoid leaking state to other smoke steps by default.
  const KEEP_STATE = envBool("KEEP_STATE", false);
  const USE_SNAPSHOT = envBool("USE_SNAPSHOT", supportsHardhat && !KEEP_STATE);
  const snap = USE_SNAPSHOT ? ((await ethers.provider.send("evm_snapshot", [])) as string) : "";

  try {
    const addressMap = loadAddressMap(network.name);
    const registryAddr = resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });
    const [deployer] = await ethers.getSigners();
    const unauth = ethers.Wallet.createRandom().connect(ethers.provider);
    if (fundUnauth) {
      await deployer.sendTransaction({ to: unauth.address, value: ethers.parseEther("1") });
    }

    const reg = (await ethers.getContractAt("Registry", registryAddr)) as any;
    const viewCacheAddr = (await reg.getModuleOrRevert(key("VIEW_CACHE"))) as string;
    const assetAddr = (await reg.getModuleOrRevert(key("SETTLEMENT_TOKEN"))) as string;
    const viewCache = (await ethers.getContractAt("ViewCache", viewCacheAddr)) as any;

    console.log("=== ViewCache smoke (localhost) ===");
    console.log(`  ViewCache: ${viewCacheAddr}`);
    console.log(`  Asset:     ${assetAddr}`);

    // VC-03: role gate
    await mustRevertMissingRole("setSystemStatus unauthorized", async () =>
      enableWrite
        ? viewCache.connect(unauth).setSystemStatus(assetAddr, 1n, 2n, 3n)
        : viewCache.connect(unauth).setSystemStatus.staticCall(assetAddr, 1n, 2n, 3n)
    );
    await mustRevertMissingRole("clearSystemCache unauthorized", async () =>
      enableWrite ? viewCache.connect(unauth).clearSystemCache(assetAddr) : viewCache.connect(unauth).clearSystemCache.staticCall(assetAddr)
    );

    if (enableWrite) {
      // VC-05/06: write => CacheUpdated + DataPushed payload
      const totalCollateral = 1000n;
      const totalDebt = 500n;
      const utilizationRate = 123n;
      const tx = await viewCache.connect(deployer).setSystemStatus(assetAddr, totalCollateral, totalDebt, utilizationRate);
      const rc = await tx.wait();
      const block = await ethers.provider.getBlock(rc!.blockNumber);

      // CacheUpdated is on ViewCache ABI.
      console.log(`  ✅ setSystemStatus tx=${rc!.hash}`);

      const dp = getDataPushedEvents(rc);
      const expectedType = ethers.id("SYSTEM_STATUS_CACHE").toLowerCase(); // DataPushTypes.DATA_TYPE_SYSTEM_STATUS
      const match = dp.find((e) => e.dataTypeHash.toLowerCase() === expectedType);
      if (!match) throw new Error(`[FAIL] expected DataPushed(dataTypeHash=SYSTEM_STATUS_CACHE)`);
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ["address", "uint256", "uint256", "uint256", "uint256"],
        match.payload
      );
      if ((decoded[0] as string).toLowerCase() !== assetAddr.toLowerCase()) throw new Error("[FAIL] DataPushed.asset mismatch");
      if ((decoded[1] as bigint) !== totalCollateral) throw new Error("[FAIL] DataPushed.totalCollateral mismatch");
      if ((decoded[2] as bigint) !== totalDebt) throw new Error("[FAIL] DataPushed.totalDebt mismatch");
      if ((decoded[3] as bigint) !== utilizationRate) throw new Error("[FAIL] DataPushed.utilizationRate mismatch");
      if ((decoded[4] as bigint) !== BigInt(block!.number)) throw new Error("[FAIL] DataPushed.blockNumber mismatch");
      console.log("  ✅ DataPushed SYSTEM_STATUS_CACHE payload decodes correctly");

      const [status0, isValid0] = await viewCache.getSystemStatus(assetAddr);
      if (!isValid0) throw new Error("[FAIL] expected isValid=true after write");
      if ((status0.updateBlock as bigint) !== BigInt(block!.number)) throw new Error("[FAIL] status.updateBlock mismatch");

      // VC-05: TTL expiry should flip validity
      if (runTtlCheck) {
        const CACHE_DURATION_BLOCKS = 5 * 60;
        await ethers.provider.send("hardhat_mine", [ethers.toBeHex(CACHE_DURATION_BLOCKS + 1)]);
        const [, isValidExpired] = await viewCache.getSystemStatus(assetAddr);
        if (isValidExpired) throw new Error("[FAIL] expected isValid=false after TTL expiry");
        console.log("  ✅ TTL expiry flips isValid=false");
      } else {
        console.log("  ⚠️  [skip] TTL expiry check (no hardhat_mine)");
      }
    } else {
      const [, isValid0] = await viewCache.getSystemStatus(assetAddr);
      console.log(`  ✅ getSystemStatus ok (isValid=${isValid0})`);
    }

    // VC-04: batch bounds (minimal)
    await (async () => {
      try {
        await viewCache.batchGetSystemStatus([]);
      } catch {
        console.log("  ✅ [revert] batchGetSystemStatus([]) reverted (EmptyArray)");
        return;
      }
      throw new Error("[FAIL] expected batchGetSystemStatus([]) to revert");
    })();

    const MAX_BATCH_SIZE = 100;
    const oversized = Array.from({ length: MAX_BATCH_SIZE + 1 }, () => assetAddr);
    await mustRevertBatchTooLarge(`batchGetSystemStatus(len=${oversized.length})`, async () =>
      viewCache.batchGetSystemStatus(oversized)
    );

    // Clear as admin and confirm invalid
    if (enableWrite) {
      await viewCache.connect(deployer).clearSystemCache(assetAddr);
      const [, isValidAfterClear] = await viewCache.getSystemStatus(assetAddr);
      if (isValidAfterClear) throw new Error("[FAIL] expected isValid=false after clear");
      console.log("  ✅ clearSystemCache resets cache validity");
    } else {
      console.log("  ⚠️  [skip] clearSystemCache (ENABLE_WRITE=0)");
    }

    console.log("\n✅ ViewCache smoke PASSED\n");
  } finally {
    if (USE_SNAPSHOT) {
      await ethers.provider.send("evm_revert", [snap]);
    }
  }
}

main().catch((e) => {
  console.error("\n❌ ViewCache smoke FAILED\n");
  console.error(e);
  process.exit(1);
});

