import { ethers, network } from "hardhat";
import { envBool, loadAddressMap, resolveAddress } from "./_addressResolver";

/**
 * Pre-config for strict smoke scripts (production-like, no auto-config inside smoke).
 *
 * What it does (idempotent):
 * - AssetWhitelist: ensure MockUSDC is allowed
 * - PriceOracle: ensure MockUSDC is configured active + push a fresh $1 price
 * - FeeRouter: (sanity) ensure MockUSDC is supported (should already be set by deploylocal)
 *
 * What it does NOT do:
 * - does NOT auto-grant any roles (roles must be granted beforehand)
 *
 * Usage:
 *   pnpm -s exec hardhat run "scripts/tests/preconfig-strict-smoke-local.ts" --network localhost
 */
async function main() {
  const readOnly = envBool("READ_ONLY", network.name !== "localhost");
  const enableWrite = envBool("ENABLE_WRITE", !readOnly);
  const grantRole = envBool("GRANT_ROLE", false);
  const requireAuthz = envBool("REQUIRE_AUTHZ", true);

  const [deployer] = await ethers.getSigners();

  const addressMap = loadAddressMap(network.name);
  const registryAddr = resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });
  const registry = (await ethers.getContractAt("Registry", registryAddr)) as any;

  const acmAddr = (await registry.getModuleOrRevert(ethers.keccak256(ethers.toUtf8Bytes("ACCESS_CONTROL_MANAGER")))) as string;
  const awAddr = (await registry.getModuleOrRevert(ethers.keccak256(ethers.toUtf8Bytes("ASSET_WHITELIST")))) as string;
  const poAddr = (await registry.getModuleOrRevert(ethers.keccak256(ethers.toUtf8Bytes("PRICE_ORACLE")))) as string;
  const feeRouterAddr = (await registry.getModuleOrRevert(ethers.keccak256(ethers.toUtf8Bytes("FEE_ROUTER")))) as string;
  const tokenAddr = (await registry.getModuleOrRevert(ethers.keccak256(ethers.toUtf8Bytes("SETTLEMENT_TOKEN")))) as string;

  const acm = (await ethers.getContractAt("AccessControlManager", acmAddr)) as any;
  const awRead = (await ethers.getContractAt("IAssetWhitelistRead", awAddr)) as any;
  const awAdmin = (await ethers.getContractAt("IAssetWhitelistAdmin", awAddr)) as any;
  const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", poAddr)) as any;
  const feeRouter = (await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", feeRouterAddr)) as any;
  const usdc = (await ethers.getContractAt("MockERC20", tokenAddr)) as any;

  console.log(`=== Pre-config strict smoke (${network.name}) ===`);
  console.log(`Config: READ_ONLY=${readOnly} ENABLE_WRITE=${enableWrite} GRANT_ROLE=${grantRole} REQUIRE_AUTHZ=${requireAuthz}`);
  console.log("  deployer:", deployer.address);
  console.log("  MockUSDC:", usdc.target);
  console.log("  AccessControlManager:", await acm.getAddress());
  console.log("  AssetWhitelist:", awAddr);
  console.log("  PriceOracle:", await po.getAddress());
  console.log("  FeeRouter:", await feeRouter.getAddress());

  // Roles (ACM actions)
  const ACTION_ADD_WHITELIST = ethers.keccak256(ethers.toUtf8Bytes("ADD_WHITELIST"));
  const ACTION_UPDATE_PRICE = ethers.keccak256(ethers.toUtf8Bytes("UPDATE_PRICE"));
  const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes("SET_PARAMETER"));

  async function ensureRole(role: string, who: string, label: string): Promise<boolean> {
    const has = (await acm.hasRole(role, who)) as boolean;
    if (has) return true;
    if (grantRole && enableWrite && network.name === "localhost") {
      try {
        await (await acm.connect(deployer).grantRole(role, who)).wait();
        console.log(`  ✅ granted role ${label} to ${who}`);
        return true;
      } catch (e: any) {
        console.log(`  ⚠️  failed to grant role ${label} to ${who}:`, e?.shortMessage ?? e?.message ?? String(e));
        return false;
      }
    }
    console.log(`  ⚠️  missing role ${label} for ${who}`);
    return false;
  }

  const canWhitelist = await ensureRole(ACTION_ADD_WHITELIST, deployer.address, "ADD_WHITELIST(deployer)");
  const canUpdatePrice = await ensureRole(ACTION_UPDATE_PRICE, deployer.address, "UPDATE_PRICE(deployer)");
  const canSetParam = await ensureRole(ACTION_SET_PARAMETER, deployer.address, "SET_PARAMETER(deployer)");

  if (requireAuthz && enableWrite && (!canWhitelist || !canUpdatePrice || !canSetParam)) {
    const missing: string[] = [];
    if (!canWhitelist) missing.push("ADD_WHITELIST");
    if (!canUpdatePrice) missing.push("UPDATE_PRICE");
    if (!canSetParam) missing.push("SET_PARAMETER");
    throw new Error(
      `[AccessControl] Missing required roles for preconfig writes: ${missing.join(", ")}. ` +
        `Fix: run scripts/tests/grant-required-roles-local.ts (localhost) or set GRANT_ROLE=1 if deployer can grant.`
    );
  }

  // 1) AssetWhitelist
  const allowed = await awRead.isAssetAllowed(usdc.target);
  if (!allowed && enableWrite) {
    const tx = await awAdmin.connect(deployer).addAllowedAsset(usdc.target);
    await tx.wait();
    console.log("  ✅ AssetWhitelist allowed MockUSDC");
  } else if (!allowed) {
    console.log("  ⚠️  AssetWhitelist does NOT allow token (read-only; skipping addAllowedAsset)");
  } else {
    console.log("  ℹ️  AssetWhitelist already allows MockUSDC");
  }

  // 2) PriceOracle config + fresh price
  const cfg = await po.getAssetConfig(usdc.target);
  if (!cfg.isActive && enableWrite) {
    const usdcDecimals = Number(await usdc.decimals().catch(() => 6));
    const tx = await po.connect(deployer).configureAsset(usdc.target, "usd-coin", usdcDecimals, 3600);
    await tx.wait();
    console.log("  ✅ PriceOracle configured MockUSDC (active)");
  } else if (!cfg.isActive) {
    console.log("  ⚠️  PriceOracle config is inactive (read-only; skipping configureAsset)");
  } else {
    console.log("  ℹ️  PriceOracle config already active for MockUSDC");
  }
  if (enableWrite) {
    const now = await ethers.provider.getBlockNumber();
    const usdcDecimals = Number(await usdc.decimals().catch(() => 6));
    const tx2 = await po.connect(deployer).updatePrice(usdc.target, ethers.parseUnits("1", usdcDecimals), now);
    await tx2.wait();
    console.log("  ✅ PriceOracle price updated for MockUSDC (fresh)");
  } else {
    // Best-effort read sanity.
    try {
      const [p, b] = (await po.getPrice(usdc.target)) as [bigint, bigint, bigint];
      console.log(`  ℹ️  PriceOracle.getPrice ok (price=${p.toString()} block=${b.toString()})`);
    } catch (e: any) {
      console.log("  ⚠️  PriceOracle.getPrice failed (read-only):", e?.message ?? String(e));
    }
  }

  // 3) FeeRouter sanity (strict smoke requires it)
  const supported = await feeRouter.isTokenSupported(usdc.target);
  if (!supported) {
    console.log("  ⚠️  FeeRouter does NOT support MockUSDC yet (strict smoke will fail until supported).");
  } else {
    console.log("  ✅ FeeRouter supports MockUSDC");
  }

  console.log("\n✅ Pre-config DONE\n");
}

main().catch((e) => {
  console.error("\n❌ Pre-config FAILED\n");
  console.error(e);
  process.exit(1);
});

