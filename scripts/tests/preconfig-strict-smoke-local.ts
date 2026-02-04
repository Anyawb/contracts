import { ethers, network } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";

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
  if (network.name !== "localhost") {
    throw new Error(`This script must run with --network localhost (got ${network.name})`);
  }

  const [deployer] = await ethers.getSigners();

  const aw = (await ethers.getContractAt("AssetWhitelist", CONTRACT_ADDRESSES.AssetWhitelist)) as any;
  const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", CONTRACT_ADDRESSES.PriceOracle)) as any;
  const feeRouter = (await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", CONTRACT_ADDRESSES.FeeRouter)) as any;
  const usdc = (await ethers.getContractAt("MockERC20", CONTRACT_ADDRESSES.MockUSDC)) as any;

  console.log("=== Pre-config strict smoke (localhost) ===");
  console.log("  deployer:", deployer.address);
  console.log("  MockUSDC:", usdc.target);
  console.log("  AssetWhitelist:", await aw.getAddress());
  console.log("  PriceOracle:", await po.getAddress());
  console.log("  FeeRouter:", await feeRouter.getAddress());

  // 1) AssetWhitelist
  const allowed = await aw.isAssetAllowed(usdc.target);
  if (!allowed) {
    const tx = await aw.connect(deployer).addAllowedAsset(usdc.target);
    await tx.wait();
    console.log("  ✅ AssetWhitelist allowed MockUSDC");
  } else {
    console.log("  ℹ️  AssetWhitelist already allows MockUSDC");
  }

  // 2) PriceOracle config + fresh price
  const cfg = await po.getAssetConfig(usdc.target);
  if (!cfg.isActive) {
    const usdcDecimals = Number(await usdc.decimals().catch(() => 6));
    const tx = await po.connect(deployer).configureAsset(usdc.target, "usd-coin", usdcDecimals, 3600);
    await tx.wait();
    console.log("  ✅ PriceOracle configured MockUSDC (active)");
  } else {
    console.log("  ℹ️  PriceOracle config already active for MockUSDC");
  }
  const now = await ethers.provider.getBlockNumber();
  const tx2 = await po.connect(deployer).updatePrice(usdc.target, ethers.parseUnits("1", 8), now);
  await tx2.wait();
  console.log("  ✅ PriceOracle price updated for MockUSDC (fresh)");

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

