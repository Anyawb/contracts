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
    const signers = await ethers.getSigners();
    const deployer = signers[0];
    const borrower = signers[1];
    const outsider = signers[2];

    console.log("=== E2E LendingEngineView Acceptance (ARCH 4.12) ===\n");

    await runViewPreflight({
      registryAddr: CONTRACT_ADDRESSES.Registry,
      acmAddr: CONTRACT_ADDRESSES.AccessControlManager,
      adminSigner: deployer,
      assetForPriceCheck: CONTRACT_ADDRESSES.MockUSDC,
    });

    const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
    const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;
    const usdc = (await ethers.getContractAt("MockERC20", CONTRACT_ADDRESSES.MockUSDC)) as any;
    const vaultCore = (await ethers.getContractAt("VaultCore", CONTRACT_ADDRESSES.VaultCore)) as any;
    const aw = (await ethers.getContractAt("AssetWhitelist", CONTRACT_ADDRESSES.AssetWhitelist)) as any;

    const viewAddr = (await registry.getModuleOrRevert(key("LENDING_ENGINE_VIEW"))) as string;
    const view = (await ethers.getContractAt("LendingEngineView", viewAddr)) as any;
    const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;
    const orderEngine = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", orderEngineAddr)) as any;

    console.log("  LendingEngineView:", viewAddr);
    console.log("  ORDER_ENGINE:", orderEngineAddr);

    assertNoPushEntryPoints(view, "LendingEngineView");

    // helper: grant roles
    const ensureRole = async (roleName: string, who: string | any) => {
      const whoAddr = await ethers.resolveAddress(who);
      const role = key(roleName);
      if (!(await acm.hasRole(role, whoAddr))) {
        await (await acm.grantRole(role, whoAddr)).wait();
      }
    };

    // Make sure borrower can create an order (minimal setup)
    await ensureRole("ADD_WHITELIST", deployer.address);
    await ensureRole("ORDER_CREATE", borrower.address);
    await ensureRole("DEPOSIT", borrower.address);
    await ensureRole("BORROW", borrower.address);
    // OrderEngine mints LoanNFT; mint is gated by ActionKeys.ACTION_BORROW (see LoanNFT.MINTER_ROLE_VAR)
    await ensureRole("BORROW", orderEngineAddr);
    await ensureRole("DEPOSIT", orderEngineAddr);

    const assetAddr = usdc.target as string;
    if (!(await aw.isAssetAllowed(assetAddr))) {
      await (await aw.connect(deployer).addAllowedAsset(assetAddr)).wait();
    }

    // Seed borrower collateral so order exists and access checks are meaningful
    const collateralAmt = ethers.parseUnits("5000", 6);
    await (await usdc.connect(deployer).transfer(borrower.address, collateralAmt)).wait();
    await (await usdc.connect(borrower).approve(CONTRACT_ADDRESSES.VaultCore, collateralAmt)).wait();
    await (await usdc.connect(borrower).approve(CONTRACT_ADDRESSES.CollateralManager, collateralAmt)).wait();
    await (await vaultCore.connect(borrower).deposit(assetAddr, collateralAmt)).wait();

    const principal = ethers.parseUnits("1200", 6);
    const rateBps = 1000n;
    const termSec = 5n * 24n * 60n * 60n;
    const order = {
      principal,
      rate: rateBps,
      term: termSec,
      borrower: borrower.address,
      lender: CONTRACT_ADDRESSES.LenderPoolVault,
      asset: assetAddr,
      startTimestamp: 0,
      maturity: 0,
      repaidAmount: 0,
    } as const;

    // Prefer return value via staticCall (more robust than log parsing).
    const orderId = (await orderEngine.connect(borrower).createLoanOrder.staticCall(order)) as bigint;
    await (await orderEngine.connect(borrower).createLoanOrder(order)).wait();

    const missingRoleSel = errorSelector("MissingRole()");

    // ====== MUST: privacy gates ======
    await mustSucceed("Borrower can read own order via view.getLoanOrder", async () => view.connect(borrower).getLoanOrder(orderId));

    await mustRevertWithSelector(
      "Outsider cannot read loan order via view.getLoanOrder",
      async () => view.connect(outsider).getLoanOrder(orderId),
      missingRoleSel
    );

    await mustRevertWithSelector(
      "Outsider cannot read borrower loan count",
      async () => view.connect(outsider).getUserLoanCount(borrower.address),
      missingRoleSel
    );

    // Ops/admin can read after VIEW_USER_DATA
    const ops = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: ops.address, value: ethers.parseEther("1") });

    await mustRevertWithSelector(
      "Ops without VIEW_USER_DATA cannot read loan order",
      async () => view.connect(ops).getLoanOrder(orderId),
      missingRoleSel
    );
    await ensureRole("VIEW_USER_DATA", ops.address);
    await mustSucceed("Ops with VIEW_USER_DATA can read loan order", async () => view.connect(ops).getLoanOrder(orderId));

    // ====== MUST: system ops gates ======
    await mustRevertWithSelector(
      "Ops without VIEW_SYSTEM_DATA cannot read failed fee amount",
      async () => view.connect(ops).getFailedFeeAmount(orderId),
      missingRoleSel
    );
    await ensureRole("VIEW_SYSTEM_DATA", ops.address);
    await mustSucceed("Ops with VIEW_SYSTEM_DATA can read failed fee amount", async () => view.connect(ops).getFailedFeeAmount(orderId));

    console.log("\n✅ LendingEngineView acceptance PASSED");
  } finally {
    await revertTo(snap);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

