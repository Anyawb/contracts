import { ethers, network } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";
import { runViewPreflight } from "./utils/view-preflight";

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

async function mustRevertMissingRole(label: string, fn: () => Promise<unknown>) {
  const missingRoleSel = ethers.id("MissingRole()").slice(0, 10); // 4-byte selector
  try {
    await fn();
  } catch (e: any) {
    const msg = fmtErr(e);
    if (isMissingSelectorError(msg)) {
      throw new Error(
        `[FAIL] ${label}: missing function selector on-chain (deployment/ABI mismatch). Re-run compile + deploy:localhost.`
      );
    }
    const hay = `${msg} ${e?.data ?? ""} ${e?.info?.error?.data ?? ""}`;
    assertOk(
      hay.includes("MissingRole") || hay.toLowerCase().includes(missingRoleSel.toLowerCase()),
      `[FAIL] ${label}: expected MissingRole(), got: ${hay}`
    );
    console.log(`  ✅ [revert MissingRole as expected] ${label}`);
    return;
  }
  throw new Error(`[FAIL] Expected MissingRole() revert, but succeeded: ${label}`);
}

async function snapshot(): Promise<string> {
  return await network.provider.send("evm_snapshot", []);
}

async function revertTo(id: string) {
  await network.provider.send("evm_revert", [id]);
}

async function main() {
  const snap = await snapshot();
  try {
    const [deployer] = await ethers.getSigners();

    console.log("=== E2E ModuleHealthView Acceptance (ARCH 4.15) ===\n");

    const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
    const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;

    await runViewPreflight({
      registryAddr: CONTRACT_ADDRESSES.Registry,
      acmAddr: CONTRACT_ADDRESSES.AccessControlManager,
      adminSigner: deployer,
      assetForPriceCheck: CONTRACT_ADDRESSES.MockUSDC,
    });

    const mhvAddr = (await registry.getModuleOrRevert(key("MODULE_HEALTH_VIEW"))) as string;
    const mhv = (await ethers.getContractAt("ModuleHealthView", mhvAddr)) as any;

    console.log("  Registry:", CONTRACT_ADDRESSES.Registry);
    console.log("  ModuleHealthView:", mhvAddr);

    // ====== Roles ======
    const ROLE_SYSTEM_STATUS = key("ACTION_VIEW_SYSTEM_STATUS");

    // Create an operator with only ACTION_VIEW_SYSTEM_STATUS (no admin)
    const operator = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: operator.address, value: ethers.parseEther("1") });
    if (!(await acm.hasRole(ROLE_SYSTEM_STATUS, operator.address))) {
      await (await acm.connect(deployer).grantRole(ROLE_SYSTEM_STATUS, operator.address)).wait();
    }

    const unauthorized = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: unauthorized.address, value: ethers.parseEther("1") });

    const targetModule = CONTRACT_ADDRESSES.VaultCore; // guaranteed contract address in local deploy
    const DATA_TYPE_MODULE_HEALTH = key("MODULE_HEALTH");
    const DETAILS_HEALTHY_HASH = ethers.keccak256(ethers.toUtf8Bytes("Module is healthy"));

    // ====== MUST: unauthorized must revert MissingRole() ======
    await mustRevertMissingRole("unauthorized.checkAndPushModuleHealth", async () =>
      mhv.connect(unauthorized).checkAndPushModuleHealth(targetModule)
    );
    await mustRevertMissingRole("unauthorized.getModuleHealthStatus", async () =>
      mhv.connect(unauthorized).getModuleHealthStatus(targetModule)
    );
    await mustRevertMissingRole("unauthorized.getModuleHealthStatusWithMeta", async () =>
      mhv.connect(unauthorized).getModuleHealthStatusWithMeta(targetModule)
    );
    await mustRevertMissingRole("unauthorized.checkModuleHealth", async () =>
      mhv.connect(unauthorized).checkModuleHealth(targetModule)
    );

    // ====== MUST: operator can call checkAndPush + read ======
    const tx = await mhv.connect(operator).checkAndPushModuleHealth(targetModule);
    const receipt = await tx.wait();
    assertOk(!!receipt, "missing receipt for checkAndPushModuleHealth");

    // Verify DataPushed(DATA_TYPE_MODULE_HEALTH, payload) emitted by ModuleHealthView
    const dpIface = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
    const dpTopic = dpIface.getEvent("DataPushed").topicHash;
    const logs = receipt.logs
      .filter((l: any) => l.address?.toLowerCase() === mhvAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === dpTopic);
    assertOk(logs.length >= 1, "expected DataPushed from ModuleHealthView");
    const parsed = dpIface.parseLog({ topics: logs[0].topics, data: logs[0].data });
    assertOk(parsed.args.dataTypeHash === DATA_TYPE_MODULE_HEALTH, "unexpected dataTypeHash for module health");

    const [m, ok, detailsHash, failures, ts] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["address", "bool", "bytes32", "uint32", "uint256"],
      parsed.args.payload
    ) as unknown as [string, boolean, string, bigint, bigint];
    assertOk(m.toLowerCase() === targetModule.toLowerCase(), "payload.module mismatch");
    assertOk(ok === true, "payload.ok must be true for a real contract");
    assertOk(detailsHash.toLowerCase() === DETAILS_HEALTHY_HASH.toLowerCase(), "payload.detailsHash mismatch");
    assertOk(failures === 0n, "payload.failures must be 0 for healthy module");
    assertOk(ts > 0n, "payload.ts must be non-zero");

    const [status, ts2, isValid] = (await mhv
      .connect(operator)
      .getModuleHealthStatusWithMeta(targetModule)) as [{ lastCheckTime: bigint; isHealthy: boolean; detailsHash: string }, bigint, boolean];
    assertOk(ts2 === status.lastCheckTime, "meta.timestamp must equal status.lastCheckTime");
    assertOk(isValid === true, "fresh cache must be valid");
    assertOk(status.isHealthy === true, "status.isHealthy must be true");
    assertOk(status.detailsHash.toLowerCase() === DETAILS_HEALTHY_HASH.toLowerCase(), "status.detailsHash mismatch");

    // ====== MUST: TTL expiry flips isValid=false but preserves timestamp ======
    // ViewConstants.CACHE_DURATION = 5 minutes
    await network.provider.send("evm_increaseTime", [5 * 60 + 1]);
    await network.provider.send("evm_mine", []);

    const [, ts3, isValid3] = (await mhv
      .connect(operator)
      .getModuleHealthStatusWithMeta(targetModule)) as [unknown, bigint, boolean];
    assertOk(ts3 === ts2, "timestamp must not change without a new push");
    assertOk(isValid3 === false, "after TTL, cache must be invalid");

    console.log("\n✅ ModuleHealthView acceptance checks passed.");
  } finally {
    await revertTo(snap);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

