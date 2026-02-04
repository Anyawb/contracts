import { ethers } from "hardhat";
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
  // Try common hardhat/ethers error shapes first
  const candidates: Array<unknown> = [
    e?.error?.data,
    e?.error?.error?.data,
    e?.error?.data?.data,
    e?.error?.error?.data?.data,
    e?.error?.data?.result,
    e?.error?.error?.data?.result,
    e?.info?.error?.data,
    e?.info?.error?.error?.data,
    e?.info?.error?.data?.data,
    e?.info?.error?.error?.data?.data,
    e?.info?.error?.data?.result,
    e?.info?.error?.error?.data?.result,
    e?.data?.data,
    e?.data?.result,
    e?.data,
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
  // raw may be "MissingRole()" or just "MissingRole"
  return raw.includes("(") ? raw : `${raw}()`;
}

async function mustRevert(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e: any) {
    const msg = fmtErr(e);
    if (isMissingSelectorError(String(msg))) {
      throw new Error(
        `[FAIL] ${label}: call reverted due to missing function selector (deployment/ABI mismatch). Re-run compile + deploy:localhost.`
      );
    }
    console.log(`  ✅ [revert as expected] ${label}: ${msg}`);
    return;
  }
  throw new Error(`[FAIL] Expected revert, but succeeded: ${label}`);
}

async function mustRevertWithSelector(label: string, fn: () => Promise<unknown>, expectedSel: string) {
  try {
    await fn();
  } catch (e: any) {
    const msg = fmtErr(e);
    if (isMissingSelectorError(String(msg))) {
      throw new Error(
        `[FAIL] ${label}: call reverted due to missing function selector (deployment/ABI mismatch). Re-run compile + deploy:localhost.`
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

async function mustRevertWithSelectorRaw(label: string, to: string, data: string, expectedSel: string) {
  try {
    await ethers.provider.call({ to, data });
  } catch (e: any) {
    const msg = fmtErr(e);
    if (isMissingSelectorError(String(msg))) {
      throw new Error(
        `[FAIL] ${label}: call reverted due to missing function selector (deployment/ABI mismatch). Re-run compile + deploy:localhost.`
      );
    }
    const raw = extractRevertData(e);
    const sel = raw && raw.startsWith("0x") && raw.length >= 10 ? raw.slice(0, 10).toLowerCase() : undefined;
    assertOk(!!sel, `${label}: missing revert data (cannot validate selector)`);
    assertOk(sel === expectedSel.toLowerCase(), `${label}: unexpected error selector ${sel}, expected ${expectedSel}`);
    console.log(`  ✅ [revert selector ok] ${label}: ${sel}`);
    return;
  }
  throw new Error(`[FAIL] Expected revert, but succeeded: ${label}`);
}

async function snapshot(): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await (ethers.provider as any).send("evm_snapshot", [])) as string;
}

async function revertTo(id: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (ethers.provider as any).send("evm_revert", [id]);
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

async function main() {
  const snap = await snapshot();
  try {
    const [deployer] = await ethers.getSigners();

    console.log("=== E2E ValuationOracleView Acceptance (ARCH 4.8) ===\n");

    const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
    const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;

    const vovAddr = (await registry.getModuleOrRevert(key("VALUATION_ORACLE_VIEW"))) as string;
    const vov = (await ethers.getContractAt("ValuationOracleView", vovAddr)) as any;

    const batchAddr = (await registry.getModuleOrRevert(key("BATCH_VIEW"))) as string;
    const batch = (await ethers.getContractAt("BatchView", batchAddr)) as any;

    await runViewPreflight({
      registryAddr: CONTRACT_ADDRESSES.Registry,
      acmAddr: CONTRACT_ADDRESSES.AccessControlManager,
      adminSigner: deployer,
      assetForPriceCheck: CONTRACT_ADDRESSES.MockUSDC,
    });

    console.log("  Registry:", CONTRACT_ADDRESSES.Registry);
    console.log("  ValuationOracleView:", vovAddr);
    console.log("  BatchView:", batchAddr);

    // ====== MUST: permission gate consistent (VIEW_PRICE_DATA) ======
    // Use a fresh random wallet to avoid any pre-granted roles.
    const randomCaller = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: randomCaller.address, value: ethers.parseEther("1") });

    const asset = CONTRACT_ADDRESSES.MockUSDC;

    // First assert both are gated for a caller without role (and selectors match).
    const expectedMissingRole0 = errorSelector("MissingRole()");
    await mustRevertWithSelector("Unauthorized: ValuationOracleView.getAssetPrice", async () => vov.connect(randomCaller).getAssetPrice(asset), expectedMissingRole0);
    await mustRevertWithSelector(
      "Unauthorized: BatchView.batchGetAssetPrices",
      async () => batch.connect(randomCaller).batchGetAssetPrices([asset]),
      expectedMissingRole0
    );

    // Then grant the role to that caller and ensure both succeed (symmetry check).
    const ROLE_VIEW_PRICE_DATA = key("VIEW_PRICE_DATA");
    if (!(await acm.hasRole(ROLE_VIEW_PRICE_DATA, randomCaller.address))) {
      await acm.connect(deployer).grantRole(ROLE_VIEW_PRICE_DATA, randomCaller.address);
    }
    await mustSucceed("Authorized(random): VOV.getAssetPrice", async () => vov.connect(randomCaller).getAssetPrice(asset));
    await mustSucceed("Authorized(random): BatchView.batchGetAssetPrices", async () => batch.connect(randomCaller).batchGetAssetPrices([asset]));

    // Revoke to make sure gating flips back (if ACM supports revokeRole).
    try {
      if (await acm.hasRole(ROLE_VIEW_PRICE_DATA, randomCaller.address)) {
        await acm.connect(deployer).revokeRole(ROLE_VIEW_PRICE_DATA, randomCaller.address);
      }
    } catch {
      // Some ACM variants may not allow revoke in this mode; ignore.
    }

    // ====== MUST: same asset price semantics between VOV and BatchView ======
    // Authorized caller must have VIEW_PRICE_DATA (deploylocal usually grants it to deployer).
    assertOk(await acm.hasRole(ROLE_VIEW_PRICE_DATA, deployer.address), "deployer missing VIEW_PRICE_DATA role");

    const [p1, block1] = (await mustSucceed("Authorized: VOV.getAssetPrice", async () =>
      vov.connect(deployer).getAssetPrice(asset)
    )) as [
      bigint,
      bigint,
      boolean,
    ];
    const items = (await mustSucceed("Authorized: BatchView.batchGetAssetPrices", async () =>
      batch.connect(deployer).batchGetAssetPrices([asset])
    )) as Array<{ asset: string; price: bigint }>;

    assertOk(items.length === 1, "batchGetAssetPrices length mismatch");
    assertOk(items[0].asset.toLowerCase() === asset.toLowerCase(), "batchGetAssetPrices.asset mismatch");
    assertOk(items[0].price === p1, "price mismatch between ValuationOracleView and BatchView");
    assertOk(typeof block1 === "bigint", "ValuationOracleView blockNumber must be bigint");

    // Mixed list: element-wise price alignment (semantic consistency).
    const unknown = ethers.Wallet.createRandom().address;
    const [prices, blockNumbers] = (await mustSucceed("Authorized: VOV.getAssetPrices([known,unknown])", async () =>
      vov.connect(deployer).getAssetPrices([asset, unknown])
    )) as [bigint[], bigint[], boolean[]];
    const items2 = (await mustSucceed("Authorized: BatchView.batchGetAssetPrices([known,unknown])", async () =>
      batch.connect(deployer).batchGetAssetPrices([asset, unknown])
    )) as Array<{ asset: string; price: bigint }>;
    assertOk(prices.length === 2 && blockNumbers.length === 2, "VOV mixed list output length mismatch");
    assertOk(items2.length === 2, "BatchView mixed list output length mismatch");
    assertOk(items2[0].asset.toLowerCase() === asset.toLowerCase(), "BatchView[0].asset mismatch");
    assertOk(items2[1].asset.toLowerCase() === unknown.toLowerCase(), "BatchView[1].asset mismatch");
    assertOk(items2[0].price === prices[0], "mixed list price[0] mismatch");
    assertOk(items2[1].price === prices[1], "mixed list price[1] mismatch");

    // ====== MUST: batch size limit enforced and parameters are correct ======
    const oversized = new Array(101).fill(asset);
    await mustRevertWithSelector(
      "Oversized: ValuationOracleView.getAssetPrices",
      async () => vov.connect(deployer).getAssetPrices(oversized),
      errorSelector("BatchTooLarge(uint256,uint256)")
    );
    const batchOversizedData = batch.interface.encodeFunctionData("batchGetAssetPrices", [oversized]);
    await mustRevertWithSelectorRaw(
      "Oversized: BatchView.batchGetAssetPrices",
      await batch.getAddress(),
      batchOversizedData,
      errorSelector("BatchTooLarge(uint256,uint256)")
    );

    // Decode revert params (length,max) from revert data (best-effort; hard fail if missing).
    const decode2 = (data: string) => ethers.AbiCoder.defaultAbiCoder().decode(["uint256", "uint256"], "0x" + data.slice(10));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tryCall = async (fn: () => Promise<any>) => { try { await fn(); } catch (e: any) { return e; } throw new Error("expected revert"); };
    const e1 = await tryCall(() => vov.connect(deployer).getAssetPrices(oversized));
    const d1 = extractRevertData(e1)!;
    const [len1, max1] = decode2(d1);
    assertOk(len1 === 101n && max1 === 100n, "BatchTooLarge args mismatch (VOV)");
    const e2 = await tryCall(() => batch.connect(deployer).batchGetAssetPrices(oversized));
    const d2 = extractRevertData(e2)!;
    const [len2, max2] = decode2(d2);
    assertOk(len2 === 101n && max2 === 100n, "BatchTooLarge args mismatch (BatchView)");

    // Empty arrays should revert with their standardized custom errors.
    await mustRevertWithSelector(
      "Empty: ValuationOracleView.getAssetPrices",
      async () => vov.connect(deployer).getAssetPrices([]),
      errorSelector("EmptyArray()")
    );
    await mustRevertWithSelector(
      "Empty: BatchView.batchGetAssetPrices",
      async () => batch.connect(deployer).batchGetAssetPrices([]),
      errorSelector("EmptyArray()")
    );

    console.log("\n✅ ValuationOracleView acceptance PASSED");
  } finally {
    await revertTo(snap);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

