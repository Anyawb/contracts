import { ethers, network } from "hardhat";
import { runViewPreflight } from "./utils/view-preflight.ts";
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

function errorSelector(sig: string): string {
  return ethers.id(sig).slice(0, 10);
}

function extractRevertData(e: any): string | undefined {
  const candidates: Array<unknown> = [
    e?.data,
    e?.data?.data,
    e?.error?.data,
    e?.error?.data?.data,
    e?.error?.error?.data,
    e?.info?.error?.data,
    e?.info?.error?.data?.data,
    e?.info?.error?.error?.data,
    e?.receipt?.revertReason,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("0x")) return c;
  }
  const msg = fmtErr(e);
  const m = String(msg).match(/return data:\s*(0x[0-9a-fA-F]+)/);
  return m?.[1];
}

async function mustRevertWithSelector(label: string, fn: () => Promise<unknown>, expectedSig: string) {
  const expectedSel = errorSelector(expectedSig).toLowerCase();
  try {
    await fn();
  } catch (e: any) {
    const msg = fmtErr(e);
    if (isMissingSelectorError(String(msg))) {
      throw new Error(
        `[FAIL] ${label}: missing function selector on-chain (deployment/ABI mismatch). Re-run compile + deploy:localhost.`
      );
    }
    const data = extractRevertData(e);
    const sel = data && data.length >= 10 ? data.slice(0, 10).toLowerCase() : "";
    assertOk(!!sel, `${label}: missing revert data (cannot validate selector)`);
    assertOk(sel === expectedSel, `${label}: unexpected selector ${sel}, expected ${expectedSel}`);
    console.log(`  ✅ [revert selector ok] ${label}: ${sel}`);
    return;
  }
  throw new Error(`[FAIL] Expected revert, but succeeded: ${label}`);
}

export async function runRewardPrivacy() {
  const supportsHardhat = network.name === "localhost" || network.name === "hardhat";
  const readOnly = envBool("READ_ONLY", network.name !== "localhost");
  const enableWrite = envBool("ENABLE_WRITE", !readOnly);

  const addressMap = loadAddressMap(network.name);
  const registryAddr = resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });

  const [admin, alice, bob] = await ethers.getSigners();

  console.log(`=== E2E Reward Privacy + Read-Gate (${network.name}) ===`);
  console.log(`Config: READ_ONLY=${readOnly} ENABLE_WRITE=${enableWrite}\n`);

  const registry = (await ethers.getContractAt("Registry", registryAddr)) as any;
  const acmAddr = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
  const assetForPriceCheck = (await registry.getModuleOrRevert(key("SETTLEMENT_TOKEN"))) as string;

  await runViewPreflight({
    registryAddr,
    acmAddr,
    adminSigner: admin,
    assetForPriceCheck,
    ensureViewPushRole: false,
    ensureHealthPushDeps: false,
  });

  const rewardViewAddr = (await registry.getModuleOrRevert(key("REWARD_VIEW"))) as string;
  const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;

  const rewardView = (await ethers.getContractAt("RewardView", rewardViewAddr)) as any;

  const missingRoleSel = "MissingRole()";

  await rewardView.connect(alice).getUserRewardSummaryWithMeta(alice.address);
  await mustRevertWithSelector(
    "RewardView.getUserRewardSummaryWithMeta(non-self)",
    async () => rewardView.connect(bob).getUserRewardSummaryWithMeta(alice.address),
    missingRoleSel
  );

  await rewardView.connect(alice).getUserBalanceWithMeta(alice.address);
  await mustRevertWithSelector(
    "RewardView.getUserBalanceWithMeta(non-self)",
    async () => rewardView.connect(bob).getUserBalanceWithMeta(alice.address),
    missingRoleSel
  );

  await mustRevertWithSelector(
    "RewardView.getEasyEmissionParamsWithMeta(non-ops)",
    async () => rewardView.connect(bob).getEasyEmissionParamsWithMeta(),
    missingRoleSel
  );
  await rewardView.connect(admin).getEasyEmissionParamsWithMeta();

  await mustRevertWithSelector(
    "RewardView.getUserLevelForBorrowCheck(non-ORDER_ENGINE)",
    async () => rewardView.connect(bob).getUserLevelForBorrowCheck(alice.address),
    missingRoleSel
  );

  if (supportsHardhat) {
    await network.provider.send("hardhat_impersonateAccount", [orderEngineAddr]);
    await network.provider.send("hardhat_setBalance", [orderEngineAddr, "0x56BC75E2D63100000"]);
    const oe = await ethers.getSigner(orderEngineAddr);
    await rewardView.connect(oe).getUserLevelForBorrowCheck(alice.address);
  } else {
    console.log("  [Notice] skip ORDER_ENGINE read-gate check (impersonation not supported)");
  }

  console.log("\n✅ e2e-localhost-reward-privacy PASSED\n");
}

async function main() {
  await runRewardPrivacy();
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const _isMain = typeof require !== "undefined" && require.main === module;
if (_isMain) {
  main().catch((e) => {
    console.error("\n❌ e2e-localhost-reward-privacy FAILED\n");
    console.error(e);
    process.exit(1);
  });
}
