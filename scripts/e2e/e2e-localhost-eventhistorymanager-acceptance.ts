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

    console.log("=== E2E EventHistoryManager Acceptance (ARCH 4.16) ===\n");

    const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
    const acm = (await ethers.getContractAt(
      "AccessControlManager",
      CONTRACT_ADDRESSES.AccessControlManager
    )) as any;

    await runViewPreflight({
      registryAddr: CONTRACT_ADDRESSES.Registry,
      acmAddr: CONTRACT_ADDRESSES.AccessControlManager,
      adminSigner: deployer,
      assetForPriceCheck: CONTRACT_ADDRESSES.MockUSDC,
    });

    const ehmAddr = (await registry.getModuleOrRevert(key("EVENT_HISTORY_MANAGER"))) as string;
    const ehm = (await ethers.getContractAt("EventHistoryManager", ehmAddr)) as any;

    console.log("  Registry:", CONTRACT_ADDRESSES.Registry);
    console.log("  EventHistoryManager:", ehmAddr);

    // ====== Roles ======
    // ActionKeys.ACTION_MANAGE_EVENT_HISTORY = keccak256("MANAGE_EVENT_HISTORY")
    const ROLE_MANAGE_EVENT_HISTORY = key("MANAGE_EVENT_HISTORY");

    const operator = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: operator.address, value: ethers.parseEther("1") });
    if (!(await acm.hasRole(ROLE_MANAGE_EVENT_HISTORY, operator.address))) {
      await (await acm.connect(deployer).grantRole(ROLE_MANAGE_EVENT_HISTORY, operator.address)).wait();
    }

    const unauthorized = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: unauthorized.address, value: ethers.parseEther("1") });

    // ====== Inputs ======
    const eventType = key("TEST_EVENT_TYPE");
    const user = operator.address;
    const asset = CONTRACT_ADDRESSES.MockUSDC;
    const amount = 123n;
    const extraData = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "string"], [42n, "hello"]);

    // DataPushTypes.DATA_TYPE_HISTORY = keccak256("EVENT_HISTORY")
    const DATA_TYPE_HISTORY = key("EVENT_HISTORY");

    // ====== MUST: unauthorized must revert MissingRole() ======
    await mustRevertMissingRole("unauthorized.recordEvent", async () =>
      ehm.connect(unauthorized).recordEvent(eventType, user, asset, amount, extraData)
    );

    // ====== MUST: recordEvent emits both HistoryRecorded and DataPushed (decodable) ======
    const tx = await ehm.connect(operator).recordEvent(eventType, user, asset, amount, extraData);
    const receipt = await tx.wait();
    assertOk(!!receipt, "missing receipt for recordEvent");

    // HistoryRecorded assertion
    const histTopic = ehm.interface.getEvent("HistoryRecorded").topicHash;
    const histLogs = receipt.logs
      .filter((l: any) => l.address?.toLowerCase() === ehmAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === histTopic);
    assertOk(histLogs.length >= 1, "expected HistoryRecorded from EventHistoryManager");
    const parsedHist = ehm.interface.parseLog({ topics: histLogs[0].topics, data: histLogs[0].data });
    assertOk(parsedHist.args.eventType === eventType, "HistoryRecorded.eventType mismatch");
    assertOk(String(parsedHist.args.user).toLowerCase() === user.toLowerCase(), "HistoryRecorded.user mismatch");
    assertOk(String(parsedHist.args.asset).toLowerCase() === asset.toLowerCase(), "HistoryRecorded.asset mismatch");
    assertOk(parsedHist.args.amount === amount, "HistoryRecorded.amount mismatch");
    assertOk(parsedHist.args.extraData === extraData, "HistoryRecorded.extraData mismatch");
    assertOk(parsedHist.args.timestamp > 0n, "HistoryRecorded.timestamp must be non-zero");

    // DataPushed assertion
    const dpIface = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
    const dpTopic = dpIface.getEvent("DataPushed").topicHash;
    const dpLogs = receipt.logs
      .filter((l: any) => l.address?.toLowerCase() === ehmAddr.toLowerCase())
      .filter((l: any) => l.topics?.[0] === dpTopic);
    assertOk(dpLogs.length >= 1, "expected DataPushed from EventHistoryManager");
    const parsedDp = dpIface.parseLog({ topics: dpLogs[0].topics, data: dpLogs[0].data });
    assertOk(parsedDp.args.dataTypeHash === DATA_TYPE_HISTORY, "unexpected dataTypeHash for history");

    const [et, u, a, amt, extra] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["bytes32", "address", "address", "uint256", "bytes"],
      parsedDp.args.payload
    ) as unknown as [string, string, string, bigint, string];
    assertOk(et === eventType, "DataPushed.payload.eventType mismatch");
    assertOk(u.toLowerCase() === user.toLowerCase(), "DataPushed.payload.user mismatch");
    assertOk(a.toLowerCase() === asset.toLowerCase(), "DataPushed.payload.asset mismatch");
    assertOk(amt === amount, "DataPushed.payload.amount mismatch");
    assertOk(extra === extraData, "DataPushed.payload.extraData mismatch");

    console.log("\n✅ EventHistoryManager acceptance checks passed.");
  } finally {
    await revertTo(snap);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

