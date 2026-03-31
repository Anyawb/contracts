import fs from "fs";
import path from "path";

import { ethers, network } from "hardhat";

import { configureAssets, type AssetConfigItem } from "../../utils/configure-assets";

function key(name: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

const PRICE_UPDATER_REGISTRY_RAW_KEY = "COINGECKO_PRICE_UPDATER";

function loadJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`invalid ${name}=${raw}`);
  }
  return value;
}

async function ensureNativeBalance(from: any, target: string, minimumWei: bigint, topUpWei: bigint) {
  const current = await ethers.provider.getBalance(target);
  if (current >= minimumWei) {
    return;
  }
  await (await from.sendTransaction({ to: target, value: topUpWei })).wait();
}

async function ensureRole(acm: any, roleName: string, account: string) {
  const role = key(roleName);
  const hasRole = (await acm.hasRole(role, account)) as boolean;
  if (!hasRole) {
    await (await acm.grantRole(role, account)).wait();
  }
}

async function ensureAllowed(awRead: any, awAdmin: any, asset: string) {
  const allowed = (await awRead.isAssetAllowed(asset)) as boolean;
  if (!allowed) {
    await (await awAdmin.addAllowedAsset(asset)).wait();
  }
}

async function ensureFeeSupported(feeRouter: any, asset: string) {
  const supported = (await feeRouter.isTokenSupported(asset)) as boolean;
  if (!supported) {
    await (await feeRouter.addSupportedToken(asset)).wait();
  }
}

async function ensureDynamicFeeConfigured(feeRouter: any, token: string, feeTypeName: string, bps: bigint) {
  const feeType = key(feeTypeName);
  const current = (await feeRouter.getDynamicFee(token, feeType)) as bigint;
  if (current === 0n) {
    await (await feeRouter.setDynamicFee(token, feeType, bps)).wait();
  }
}

async function main() {
  if (network.name !== "localhost" && network.name !== "hardhat") {
    throw new Error("prepare-live-gates-localhost only supports localhost/hardhat");
  }

  const [relayer] = await ethers.getSigners();
  const deployFile = path.join(process.cwd(), "scripts", "deployments", `${network.name}.json`);
  const assetsFile = path.join(process.cwd(), "deployments", `assets.${network.name}.mock.json`);

  if (!fs.existsSync(deployFile)) {
    throw new Error(`missing deploy file: ${deployFile}`);
  }
  if (!fs.existsSync(assetsFile)) {
    throw new Error(`missing assets file: ${assetsFile}`);
  }

  const deployMap = loadJson<Record<string, string>>(deployFile);
  const assetsConfig = loadJson<{ assets: AssetConfigItem[] }>(assetsFile);
  const registryAddr = deployMap.Registry;
  if (!registryAddr) {
    throw new Error(`Registry missing in ${deployFile}`);
  }

  const registry = (await ethers.getContractAt(
    [
      "function getModuleOrRevert(bytes32) view returns (address)",
    ],
    registryAddr,
    relayer,
  )) as any;

  const acmAddr = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
  const awAddr = (await registry.getModuleOrRevert(key("ASSET_WHITELIST"))) as string;
  const feeRouterAddr = (await registry.getModuleOrRevert(key("FEE_ROUTER"))) as string;
  const priceOracleAddr = (await registry.getModuleOrRevert(key("PRICE_ORACLE"))) as string;
  const updaterAddr = (await registry.getModuleOrRevert(key(PRICE_UPDATER_REGISTRY_RAW_KEY))) as string;
  const vblAddr = (await registry.getModuleOrRevert(key("VAULT_BUSINESS_LOGIC"))) as string;
  const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;

  const acm = (await ethers.getContractAt(
    [
      "function owner() view returns (address)",
      "function hasRole(bytes32,address) view returns (bool)",
      "function grantRole(bytes32,address)",
    ],
    acmAddr,
    relayer,
  )) as any;
  const owner = (await acm.owner()) as string;
  if (owner.toLowerCase() !== relayer.address.toLowerCase()) {
    throw new Error(`localhost bootstrap requires ACM owner signer; owner=${owner} relayer=${relayer.address}`);
  }

  const awRead = (await ethers.getContractAt(["function isAssetAllowed(address) view returns (bool)"], awAddr, relayer)) as any;
  const awAdmin = (await ethers.getContractAt(["function addAllowedAsset(address)"], awAddr, relayer)) as any;
  const feeRouter = (await ethers.getContractAt(
    [
      "function isTokenSupported(address) view returns (bool)",
      "function addSupportedToken(address)",
      "function getDynamicFee(address,bytes32) view returns (uint256)",
      "function setDynamicFee(address,bytes32,uint256)",
    ],
    feeRouterAddr,
    relayer,
  )) as any;

  for (const roleName of ["SET_PARAMETER", "ADD_WHITELIST", "UPDATE_PRICE", "LIQUIDATE", "DEPOSIT", "ACTION_ADMIN"]) {
    await ensureRole(acm, roleName, relayer.address);
  }
  for (const roleName of ["ORDER_CREATE", "DEPOSIT"]) {
    await ensureRole(acm, roleName, vblAddr);
  }
  await ensureRole(acm, "BORROW", orderEngineAddr);

  const borrowerPk = process.env.BORROWER_PRIVATE_KEY?.trim();
  const readActors = new Set<string>([relayer.address.toLowerCase()]);
  if (borrowerPk) {
    const borrower = new ethers.Wallet(borrowerPk);
    await ensureNativeBalance(relayer, borrower.address, ethers.parseEther("1"), ethers.parseEther("10"));
    readActors.add(borrower.address.toLowerCase());
  }

  const lenderPk = process.env.LENDER_PRIVATE_KEY?.trim();
  if (lenderPk) {
    const lender = new ethers.Wallet(lenderPk);
    await ensureNativeBalance(relayer, lender.address, ethers.parseEther("1"), ethers.parseEther("10"));
    readActors.add(lender.address.toLowerCase());
  }

  const viewerAddress = process.env.VIEWER_ADDRESS?.trim();
  if (viewerAddress) {
    await ensureNativeBalance(relayer, viewerAddress, ethers.parseEther("1"), ethers.parseEther("2"));
    readActors.add(viewerAddress.toLowerCase());
  }

  for (const account of readActors) {
    for (const roleName of [
      "VIEW_USER_DATA",
      "VIEW_RISK_DATA",
      "VIEW_SYSTEM_DATA",
      "VIEW_LIQUIDATION_DATA",
      "VIEW_CACHE_DATA",
      "VIEW_PRICE_DATA",
      "VIEW_DEGRADATION_DATA",
    ]) {
      await ensureRole(acm, roleName, account);
    }
  }

  const settlementToken = (await registry.getModuleOrRevert(key("SETTLEMENT_TOKEN"))) as string;
  const settlementConfigured = assetsConfig.assets.some(
    (asset) => asset.address.toLowerCase() === settlementToken.toLowerCase(),
  );
  const bootstrapAssets = settlementConfigured
    ? assetsConfig.assets
    : [
        ...assetsConfig.assets,
        {
          address: settlementToken,
          sourceId:
            process.env.SETTLEMENT_TOKEN_SOURCE_ID?.trim() ||
            process.env.SETTLEMENT_TOKEN_COINGECKO_ID?.trim() ||
            "usd-coin",
          decimals: envInt("SETTLEMENT_TOKEN_DECIMALS", 6),
          maxPriceAge: envInt("SETTLEMENT_TOKEN_MAX_PRICE_AGE", 3600),
          active: true,
        },
      ];

  for (const asset of bootstrapAssets) {
    await ensureAllowed(awRead, awAdmin, asset.address);
    await ensureFeeSupported(feeRouter, asset.address);
  }

  await configureAssets(ethers, priceOracleAddr, bootstrapAssets, updaterAddr);

  await ensureDynamicFeeConfigured(feeRouter, settlementToken, "LIVE_DYNAMIC_FEE_TEST", 200n);

  const packFile = path.join(process.cwd(), "deployments", `mock-assets.${network.name}.json`);
  console.log(`Network=${network.name}`);
  console.log(`Registry=${registryAddr}`);
  console.log(`Relayer=${relayer.address}`);
  console.log(`SettlementToken=${settlementToken}`);
  console.log(`AssetsConfigured=${bootstrapAssets.length}`);
  console.log(`MockAssetPack=${packFile}`);
  console.log("✅ prepare-live-gates-localhost PASSED");
}

main().catch((error) => {
  console.error("\n❌ prepare-live-gates-localhost FAILED\n");
  console.error(error);
  process.exit(1);
});