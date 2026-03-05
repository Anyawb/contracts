import { ethers, network } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost.ts";
import { runViewPreflight } from "./utils/view-preflight.ts";

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
  return msg.includes("function selector was not recognized");
}

function errorSelector(sig: string): string {
  return ethers.id(sig).slice(0, 10);
}

function extractRevertData(e: any): string | undefined {
  const candidates: Array<unknown> = [
    e?.data,
    e?.error?.data,
    e?.error?.error?.data,
    e?.info?.error?.data,
    e?.info?.error?.error?.data,
    e?.receipt?.revertReason,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("0x")) return c;
  }
  const msg = fmtErr(e);
  const m = String(msg).match(/return data:\s*(0x[0-9a-fA-F]+)/);
  if (m?.[1]) return m[1];
  return undefined;
}

function extractCustomErrorSigFromMessage(e: any): string | undefined {
  const msg = fmtErr(e);
  const m = String(msg).match(/custom error\s+'([^']+)'/);
  if (!m?.[1]) return undefined;
  const raw = m[1].trim();
  return raw.includes("(") ? raw : `${raw}()`;
}

async function mustRevertWithSelector(label: string, fn: () => Promise<unknown>, expectedSel: string) {
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
    let sel: string | undefined;
    if (data && data.startsWith("0x") && data.length >= 10) {
      sel = data.slice(0, 10).toLowerCase();
    } else {
      const sig = extractCustomErrorSigFromMessage(e);
      if (sig) sel = errorSelector(sig).toLowerCase();
    }
    assertOk(!!sel, `${label}: missing revert data (cannot validate selector)`);
    assertOk(sel === expectedSel.toLowerCase(), `${label}: unexpected error selector ${sel}, expected ${expectedSel}`);
    console.log(`  ✅ [revert selector ok] ${label}: ${sel}`);
    return;
  }
  throw new Error(`[FAIL] Expected revert, but succeeded: ${label}`);
}

async function mustSucceed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    const msg = fmtErr(e);
    if (isMissingSelectorError(String(msg))) {
      throw new Error(
        `[FAIL] ${label}: missing function selector on-chain (deployment/ABI mismatch). Re-run compile + deploy:localhost.`
      );
    }
    throw e;
  }
}

async function snapshot(): Promise<string> {
  return await network.provider.send("evm_snapshot", []);
}

async function revertTo(id: string) {
  await network.provider.send("evm_revert", [id]);
}

function assertNoPushEntryPoints(c: any, label: string) {
  const fns = c.interface.fragments.filter((x: any) => x.type === "function").map((x: any) => x.name);
  const pushes = fns.filter((n: string) => n.startsWith("push"));
  assertOk(pushes.length === 0, `${label}: must not expose push* entrypoints: ${pushes.join(", ")}`);
}

async function main() {
  const snap = await snapshot();
  try {
    const [deployer, borrower] = await ethers.getSigners();
    console.log("=== E2E PreviewView Acceptance (ARCH 4.13) ===\n");

    await runViewPreflight({
      registryAddr: CONTRACT_ADDRESSES.Registry,
      acmAddr: CONTRACT_ADDRESSES.AccessControlManager,
      adminSigner: deployer,
      assetForPriceCheck: CONTRACT_ADDRESSES.MockUSDC,
    });

    const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
    const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;
    const previewAddr = (await registry.getModuleOrRevert(key("PREVIEW_VIEW"))) as string;
    const preview = (await ethers.getContractAt("PreviewView", previewAddr)) as any;

    console.log("  PreviewView:", previewAddr);

    // MUST: no push*
    assertNoPushEntryPoints(preview, "PreviewView");

    // Ensure deploy-time role wiring is correct: PreviewView must be able to call PositionView internally.
    const hasPreviewUserData = (await acm.hasRole(key("VIEW_USER_DATA"), previewAddr)) as boolean;
    assertOk(hasPreviewUserData, "deploy misconfig: PreviewView must have VIEW_USER_DATA role for internal PositionView reads");

    const missingRoleSel = errorSelector("MissingRole()");

    // Use a fresh EOA with no roles for strict gate checks
    const unauth = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: unauth.address, value: ethers.parseEther("1") });

    // Unauthorized: non-self caller must revert MissingRole()
    await mustRevertWithSelector(
      "Unauthorized: previewDeposit(non-self)",
      async () => preview.connect(unauth).previewDeposit(borrower.address, CONTRACT_ADDRESSES.MockUSDC, 1n),
      missingRoleSel
    );

    await mustRevertWithSelector(
      "Unauthorized: previewWithdraw(non-self)",
      async () => preview.connect(unauth).previewWithdraw(borrower.address, CONTRACT_ADDRESSES.MockUSDC, 1n),
      missingRoleSel
    );

    await mustRevertWithSelector(
      "Unauthorized: previewBorrow(non-self)",
      async () => preview.connect(unauth).previewBorrow(borrower.address, CONTRACT_ADDRESSES.MockUSDC, 0n, 1n, 1n),
      missingRoleSel
    );

    await mustRevertWithSelector(
      "Unauthorized: previewRepay(non-self)",
      async () => preview.connect(unauth).previewRepay(borrower.address, CONTRACT_ADDRESSES.MockUSDC, 1n),
      missingRoleSel
    );

    // Self access should succeed even without VIEW_USER_DATA role (self is allowed).
    const [hfAfter, ok, isValid, ts] = (await mustSucceed("Self: previewDeposit", async () =>
      preview.connect(borrower).previewDeposit(borrower.address, CONTRACT_ADDRESSES.MockUSDC, 1n)
    )) as [bigint, boolean, boolean, bigint, bigint];
    assertOk(typeof hfAfter === "bigint" && typeof ok === "boolean", "previewDeposit return types mismatch");
    assertOk(typeof isValid === "boolean" && typeof ts === "bigint", "previewDeposit meta types mismatch");

    // Invalid input should revert with its custom error
    await mustRevertWithSelector(
      "Invalid input: asset=0 on previewDeposit",
      async () => preview.connect(borrower).previewDeposit(borrower.address, ethers.ZeroAddress, 1n),
      errorSelector("PreviewView__InvalidInput()")
    );

    console.log("\n✅ PreviewView acceptance PASSED");
  } finally {
    await revertTo(snap);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

