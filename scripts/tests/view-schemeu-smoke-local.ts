import { ethers, network } from "hardhat";
import { envBool, loadAddressMap, resolveAddress } from "./_addressResolver";
import { runWithNetworkRetry } from "./live-test/networks/arbitrum-sepolia/core/_networkRetry";

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

function extractRevertData(e: any): string | undefined {
  const roots: Array<unknown> = [
    e?.info?.error?.data,
    e?.info?.error?.error?.data,
    e?.error?.data,
    e?.error?.error?.data,
    e?.data,
    e?.receipt?.revertReason,
  ];
  const seen = new Set<unknown>();
  const stack = roots.map((v) => ({ v, depth: 0 }));
  while (stack.length) {
    const cur = stack.pop()!;
    if (!cur.v || seen.has(cur.v) || cur.depth > 4) continue;
    seen.add(cur.v);
    if (typeof cur.v === "string" && cur.v.startsWith("0x")) return cur.v;
    if (typeof cur.v === "object") {
      const obj: any = cur.v;
      for (const k of ["data", "result", "returnData", "reason", "error", "value"]) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
          stack.push({ v: obj[k], depth: cur.depth + 1 });
        }
      }
    }
  }
  return undefined;
}

async function mustRevertMissingRole(label: string, fn: () => Promise<unknown>) {
  const missingRoleSel = ethers.id("MissingRole()").slice(0, 10);
  try {
    await fn();
  } catch (e: any) {
    const msg = fmtErr(e);
    if (isMissingSelectorError(msg)) {
      throw new Error(`[FAIL] ${label}: missing selector (ABI/deploy mismatch).`);
    }
    const data = extractRevertData(e);
    const sel = data && data.length >= 10 ? data.slice(0, 10).toLowerCase() : "";
    assertOk(sel === missingRoleSel.toLowerCase() || msg.includes("MissingRole"), `[FAIL] ${label}: expected MissingRole()`);
    console.log(`  ✅ [revert MissingRole] ${label}`);
    return;
  }
  throw new Error(`[FAIL] Expected MissingRole revert, but succeeded: ${label}`);
}

async function mustSucceed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    const msg = fmtErr(e);
    if (isMissingSelectorError(msg)) {
      throw new Error(`[FAIL] ${label}: missing selector (ABI/deploy mismatch).`);
    }
    throw e;
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const addressMap = loadAddressMap(network.name);
  const registryAddr = resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });
  const grantRole = envBool("GRANT_ROLE", network.name === "localhost");
  const requireAuthz = envBool("REQUIRE_AUTHZ", true);
  const fundUnauth = envBool("FUND_UNAUTH", network.name === "localhost");
  const unauth = ethers.Wallet.createRandom().connect(ethers.provider);
  if (fundUnauth) {
    await deployer.sendTransaction({ to: unauth.address, value: ethers.parseEther("1") });
  }

  const reg = (await ethers.getContractAt("Registry", registryAddr)) as any;

  const systemViewAddr = (await reg.getModuleOrRevert(key("SYSTEM_VIEW"))) as string;
  const systemView = (await ethers.getContractAt("SystemView", systemViewAddr)) as any;
  const route = await systemView.routeSystemRisk();
  const routeKey = (route.moduleKey ?? route[0]) as string;
  const routeAddr = (route.moduleAddr ?? route[1]) as string;
  const expectedKey = key("SYSTEM_RISK_VIEW");
  const expectedAddr = (await reg.getModuleOrRevert(expectedKey)) as string;

  assertOk(routeKey.toLowerCase() === expectedKey.toLowerCase(), "routeSystemRisk moduleKey mismatch");
  assertOk(routeAddr.toLowerCase() === expectedAddr.toLowerCase(), "routeSystemRisk moduleAddr mismatch");

  const srv = (await ethers.getContractAt("SystemRiskView", expectedAddr)) as any;
  // Scheme B: SystemRiskView reads are role-gated by VIEW_RISK_DATA (with ACTION_ADMIN bypass).
  await mustRevertMissingRole("SystemRiskView.getMinHealthFactor requires VIEW_RISK_DATA", async () =>
    srv.connect(unauth).getMinHealthFactor()
  );
  await mustRevertMissingRole("SystemRiskView.getLiquidationThreshold requires VIEW_RISK_DATA", async () =>
    srv.connect(unauth).getLiquidationThreshold()
  );

  const acmAddr = (await reg.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
  const acm = (await ethers.getContractAt("AccessControlManager", acmAddr)) as any;
  const ROLE_VIEW_RISK_DATA = key("VIEW_RISK_DATA");
  let canReadSystemRisk = true;
  try {
    await srv.connect(deployer).getMinHealthFactor();
  } catch {
    canReadSystemRisk = false;
  }
  if (!canReadSystemRisk && grantRole) {
    await mustSucceed("grant VIEW_RISK_DATA to deployer (for SystemRiskView reads)", async () =>
      acm.connect(deployer).grantRole(ROLE_VIEW_RISK_DATA, deployer.address)
    );
    canReadSystemRisk = true;
  }
  if (!canReadSystemRisk && requireAuthz) {
    throw new Error("Missing VIEW_RISK_DATA on deployer (set GRANT_ROLE=1 or REQUIRE_AUTHZ=0 to skip)");
  }
  if (canReadSystemRisk) {
    await mustSucceed("SystemRiskView.getMinHealthFactor with VIEW_RISK_DATA", async () => srv.connect(deployer).getMinHealthFactor());
    await mustSucceed("SystemRiskView.getLiquidationThreshold with VIEW_RISK_DATA", async () =>
      srv.connect(deployer).getLiquidationThreshold()
    );
  } else {
    console.log("  ⚠️  [skip] SystemRiskView authorized reads (no role)");
  }

  const hvAddr = (await reg.getModuleOrRevert(key("HEALTH_VIEW"))) as string;
  const hv = (await ethers.getContractAt("HealthView", hvAddr)) as any;
  await mustSucceed("HealthView self-read (Scheme U)", async () =>
    hv.connect(unauth).getUserHealthFactorWithMeta(unauth.address)
  );
  await mustRevertMissingRole("HealthView non-self (Scheme U)", async () =>
    hv.connect(unauth).getUserHealthFactorWithMeta(deployer.address)
  );

  const rvAddr = (await reg.getModuleOrRevert(key("RISK_VIEW"))) as string;
  const rv = (await ethers.getContractAt("RiskView", rvAddr)) as any;
  await mustSucceed("RiskView self-read (Scheme U)", async () =>
    rv.connect(unauth).getUserRiskAssessment(unauth.address)
  );
  await mustRevertMissingRole("RiskView non-self (Scheme U)", async () =>
    rv.connect(unauth).getUserRiskAssessment(deployer.address)
  );
  await mustRevertMissingRole("RiskView batch no self-bypass", async () =>
    rv.connect(unauth).batchGetRiskAssessments([unauth.address])
  );

  const batchAddr = (await reg.getModuleOrRevert(key("BATCH_VIEW"))) as string;
  const batch = (await ethers.getContractAt("BatchView", batchAddr)) as any;
  await mustRevertMissingRole("BatchView.batchGetHealthFactors (Scheme U batch)", async () =>
    batch.connect(unauth).batchGetHealthFactors([unauth.address])
  );
  await mustRevertMissingRole("BatchView.batchGetRiskAssessments (Scheme U batch)", async () =>
    batch.connect(unauth).batchGetRiskAssessments([unauth.address])
  );

  if (canReadSystemRisk) {
    await mustSucceed("BatchView.batchGetHealthFactors (authorized)", async () =>
      batch.connect(deployer).batchGetHealthFactors([deployer.address])
    );
    await mustSucceed("BatchView.batchGetRiskAssessments (authorized)", async () =>
      batch.connect(deployer).batchGetRiskAssessments([deployer.address])
    );
  } else {
    console.log("  ⚠️  [skip] BatchView authorized reads (no role)");
  }

  // PreviewView follows Scheme-U for user-scoped reads.
  // Smoke: self-call succeeds, non-self call must revert MissingRole().
  const previewAddr = (await reg.getModuleOrRevert(key("PREVIEW_VIEW"))) as string;
  const preview = (await ethers.getContractAt("PreviewView", previewAddr)) as any;
  const assetAddr = (await reg.getModuleOrRevert(key("SETTLEMENT_TOKEN"))) as string;
  const z0 = 0n;

  await mustSucceed("PreviewView.previewDeposit self (Scheme U)", async () =>
    preview.connect(unauth).previewDeposit(unauth.address, assetAddr, z0)
  );
  await mustRevertMissingRole("PreviewView.previewDeposit non-self (Scheme U)", async () =>
    preview.connect(unauth).previewDeposit(deployer.address, assetAddr, z0)
  );

  console.log("\n✅ View/SchemeU smoke PASSED");
}

void runWithNetworkRetry("view-schemeu-smoke-local", main);
