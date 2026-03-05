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
    const signers = await ethers.getSigners();
    const deployer = signers[0];
    const borrower = signers[1];
    const outsider = signers[2];
    const borrowerAddr = await borrower.getAddress();
    const outsiderAddr = await outsider.getAddress();

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
    const loanNftViewAddr = (await registry.getModuleOrRevert(key("LOAN_NFT_VIEW"))) as string;
    const loanNftView = (await ethers.getContractAt("LoanNFTView", loanNftViewAddr)) as any;
    const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;
    const orderEngine = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", orderEngineAddr)) as any;

    console.log("  LendingEngineView:", viewAddr);
    console.log("  LoanNFTView:", loanNftViewAddr);
    console.log("  ORDER_ENGINE:", orderEngineAddr);

    assertNoPushEntryPoints(view, "LendingEngineView");

    // ====== MUST: version observability (5.1.2) ======
    const [apiVer, schemaVer, implAddr] = (await mustSucceed("LendingEngineView.getVersionInfo()", async () =>
      view.getVersionInfo()
    )) as [bigint, bigint, string];
    assertOk(apiVer === (await view.apiVersion()), "apiVersion mismatch vs getVersionInfo");
    assertOk(schemaVer === (await view.schemaVersion()), "schemaVersion mismatch vs getVersionInfo");
    assertOk(implAddr !== ethers.ZeroAddress, "implementation must be non-zero");
    assertOk(implAddr.toLowerCase() !== viewAddr.toLowerCase(), "implementation must differ from proxy address");
    console.log(`  [version] api=${apiVer} schema=${schemaVer} impl=${implAddr}`);

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
    await ensureRole("ORDER_CREATE", borrowerAddr);
    await ensureRole("DEPOSIT", borrowerAddr);
    await ensureRole("BORROW", borrowerAddr);
    // OrderEngine mints LoanNFT; mint is gated by ActionKeys.ACTION_BORROW (see LoanNFT.MINTER_ROLE_VAR)
    await ensureRole("BORROW", orderEngineAddr);
    await ensureRole("DEPOSIT", orderEngineAddr);

    const assetAddr = usdc.target as string;
    if (!(await aw.isAssetAllowed(assetAddr))) {
      await (await aw.connect(deployer).addAllowedAsset(assetAddr)).wait();
    }

    // Seed borrower collateral so order exists and access checks are meaningful
    const collateralAmt = ethers.parseUnits("5000", 6);
    await (await usdc.connect(deployer).transfer(borrowerAddr, collateralAmt)).wait();
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
      borrower: borrowerAddr,
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
    await mustSucceed("Borrower can read own order via view.getLoanOrder", async () =>
      view.connect(borrower).getLoanOrder(orderId)
    );

    // canAccessLoanOrder: borrower should see true; zero user should be false
    const [hasAccessBorrower] = (await mustSucceed("Borrower canAccessLoanOrder(self)", async () =>
      view.connect(borrower).canAccessLoanOrder(orderId, borrowerAddr)
    )) as [boolean, boolean, bigint];
    assertOk(hasAccessBorrower === true, "canAccessLoanOrder must be true for borrower");

    // Note: canAccessLoanOrder is user-scoped (onlyAuthorizedUser(user)).
    // user=0 is still gated, so we query it as deployer (has roles) and expect false.
    const [hasAccessZero] = (await mustSucceed("Deployer canAccessLoanOrder(zero user) returns false", async () =>
      view.connect(deployer).canAccessLoanOrder(orderId, ethers.ZeroAddress)
    )) as [boolean, boolean, bigint];
    assertOk(hasAccessZero === false, "canAccessLoanOrder must be false for user=0");

    await mustRevertWithSelector(
      "Outsider cannot read loan order via view.getLoanOrder",
      async () => view.connect(outsider).getLoanOrder(orderId),
      missingRoleSel
    );

    await mustRevertWithSelector(
      "Outsider cannot read borrower loan count",
      async () => loanNftView.connect(outsider).getUserLoanCount(borrowerAddr),
      missingRoleSel
    );

    await mustRevertWithSelector(
      "Outsider cannot call canAccessLoanOrder(borrower)",
      async () => view.connect(outsider).canAccessLoanOrder(orderId, borrowerAddr),
      missingRoleSel
    );

    // canAccessLoanOrder: self (not borrower/lender) should be allowed and return false
    const [outsiderSelfAccess] = (await mustSucceed("Outsider canAccessLoanOrder(self) returns false", async () =>
      view.connect(outsider).canAccessLoanOrder(orderId, outsiderAddr)
    )) as [boolean, boolean, bigint];
    assertOk(outsiderSelfAccess === false, "canAccessLoanOrder must be false for non-party self");

    // Ops/admin equivalence matrix:
    // - VIEW_USER_DATA grants getLoanOrder and canAccessLoanOrder(user!=caller)
    // - VIEW_SYSTEM_DATA grants ops diagnostics only
    // - ACTION_ADMIN grants both
    const opsUser = ethers.Wallet.createRandom().connect(ethers.provider);
    const opsSystem = ethers.Wallet.createRandom().connect(ethers.provider);
    const adminOnly = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: opsUser.address, value: ethers.parseEther("1") });
    await deployer.sendTransaction({ to: opsSystem.address, value: ethers.parseEther("1") });
    await deployer.sendTransaction({ to: adminOnly.address, value: ethers.parseEther("1") });

    // baseline: no roles
    await mustRevertWithSelector(
      "opsUser without VIEW_USER_DATA cannot read loan order",
      async () => view.connect(opsUser).getLoanOrder(orderId),
      missingRoleSel
    );
    await mustRevertWithSelector(
      "opsSystem without VIEW_SYSTEM_DATA cannot read failed fee amount",
      async () => view.connect(opsSystem).getFailedFeeAmount(orderId),
      missingRoleSel
    );

    // grant VIEW_USER_DATA to opsUser
    await ensureRole("VIEW_USER_DATA", opsUser.address);
    await mustSucceed("opsUser with VIEW_USER_DATA can read loan order", async () => view.connect(opsUser).getLoanOrder(orderId));
    const [opsUserAccess] = (await mustSucceed("opsUser with VIEW_USER_DATA can call canAccessLoanOrder(borrower)", async () =>
      view.connect(opsUser).canAccessLoanOrder(orderId, borrowerAddr)
    )) as [boolean, boolean, bigint];
    assertOk(opsUserAccess === true, "opsUser canAccessLoanOrder should be true for borrower order");
    await mustRevertWithSelector(
      "opsUser with VIEW_USER_DATA cannot read failed fee amount (needs VIEW_SYSTEM_DATA)",
      async () => view.connect(opsUser).getFailedFeeAmount(orderId),
      missingRoleSel
    );

    // grant VIEW_SYSTEM_DATA to opsSystem
    await ensureRole("VIEW_SYSTEM_DATA", opsSystem.address);
    await mustSucceed("opsSystem with VIEW_SYSTEM_DATA can read failed fee amount", async () => view.connect(opsSystem).getFailedFeeAmount(orderId));
    await mustRevertWithSelector(
      "opsSystem with VIEW_SYSTEM_DATA cannot read loan order (still needs VIEW_USER_DATA or party)",
      async () => view.connect(opsSystem).getLoanOrder(orderId),
      missingRoleSel
    );

    // grant ACTION_ADMIN to adminOnly (equivalent to ops+admin in view)
    await ensureRole("ACTION_ADMIN", adminOnly.address);
    await mustSucceed("adminOnly with ACTION_ADMIN can read loan order", async () => view.connect(adminOnly).getLoanOrder(orderId));
    await mustSucceed("adminOnly with ACTION_ADMIN can read failed fee amount", async () => view.connect(adminOnly).getFailedFeeAmount(orderId));

    // ====== MUST: system ops gates ======
    // Above opsSystem/adminOnly already cover this matrix.

    // ====== Edge: non-existent order behavior ======
    const missingOrderId = orderId + 999_999n;
    await mustRevertWithSelector(
      "Borrower cannot read missing orderId (treated as non-party) -> MissingRole",
      async () => view.connect(borrower).getLoanOrder(missingOrderId),
      missingRoleSel
    );
    const missingAsOps = (await mustSucceed("opsUser can read missing orderId (default struct)", async () =>
      view.connect(opsUser).getLoanOrder(missingOrderId)
    )) as any;
    assertOk(missingAsOps.principal === 0n, "missing order principal must be 0");
    assertOk(missingAsOps.borrower === ethers.ZeroAddress, "missing order borrower must be 0");

    console.log("\n✅ LendingEngineView acceptance PASSED");
  } finally {
    await revertTo(snap);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

