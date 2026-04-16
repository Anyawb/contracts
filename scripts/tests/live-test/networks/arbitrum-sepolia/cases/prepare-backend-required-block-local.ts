import fs from "fs";
import path from "path";

import { ethers, network } from "hardhat";

type MockAssetPackAsset = {
  symbol: string;
  address: string;
  decimals: number;
  sourceId: string;
  maxPriceAge: number;
  settlementToken?: boolean;
};

type MockAssetPack = {
  settlementToken: string;
  assets: MockAssetPackAsset[];
};

// 与链上 Registry 的 bytes32 key 生成规则保持一致。
function key(name: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

// 读取 localhost 对应的 mock asset pack，作为演示环境的资产事实来源。
function loadPack(): MockAssetPack {
  const packFile = path.join(process.cwd(), "deployments", `mock-assets.${network.name}.json`);
  return JSON.parse(fs.readFileSync(packFile, "utf8")) as MockAssetPack;
}

// 下面几组 ensure* 都是幂等修复：已有配置就跳过，缺失时才补齐。
async function ensureRole(acm: any, roleName: string, account: string) {
  const role = key(roleName);
  if (!(await acm.hasRole(role, account))) {
    await (await acm.grantRole(role, account)).wait();
  }
}

async function ensureAllowed(awRead: any, awAdmin: any, asset: string) {
  if (!(await awRead.isAssetAllowed(asset))) {
    await (await awAdmin.addAllowedAsset(asset)).wait();
  }
}

async function ensureFeeSupported(feeRouter: any, asset: string) {
  if (!(await feeRouter.isTokenSupported(asset))) {
    await (await feeRouter.addSupportedToken(asset)).wait();
  }
}

async function ensureConfiguredWithoutPrice(priceOracle: any, asset: MockAssetPackAsset) {
  const config = await priceOracle.getAssetConfig(asset.address);
  if (!config.isActive) {
    await (
      await priceOracle.configureAsset(
        asset.address,
        asset.sourceId,
        asset.decimals,
        asset.maxPriceAge,
      )
    ).wait();
  }
  if (!config.isActive) {
    await (await priceOracle.setAssetActive(asset.address, true)).wait();
  }
}

async function main() {
  const pack = loadPack();
  // 这里刻意只准备资产和角色，不灌价格，
  // 这样后续 backend-required warmup 才会因为缺 final price 而按预期失败。
  const collateralSymbol = (process.env.COLLATERAL_SYMBOL?.trim() || "RWAGOLD").toLowerCase();
  const settlementAsset =
    pack.assets.find((asset) => asset.address.toLowerCase() === pack.settlementToken.toLowerCase()) ??
    pack.assets.find((asset) => asset.settlementToken);

  if (!settlementAsset) {
    throw new Error("mock asset pack settlement token not found");
  }

  const collateralAsset = pack.assets.find((asset) => asset.symbol.toLowerCase() === collateralSymbol);
  if (!collateralAsset) {
    throw new Error(`collateral ${collateralSymbol} not found in mock asset pack`);
  }

  const deployFile = path.join(process.cwd(), "scripts", "deployments", `${network.name}.json`);
  const deployMap = JSON.parse(fs.readFileSync(deployFile, "utf8")) as Record<string, string>;
  const registryAddr = deployMap.Registry;
  if (!registryAddr) {
    throw new Error(`missing Registry in ${deployFile}`);
  }

  const [deployer] = await ethers.getSigners();
  const registry = await ethers.getContractAt(
    [
      "function getModule(bytes32) view returns (address)",
      "function getModuleOrRevert(bytes32) view returns (address)",
      "function setModule(bytes32,address)",
    ],
    registryAddr,
  );

  const acmAddr = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
  const awAddr = (await registry.getModuleOrRevert(key("ASSET_WHITELIST"))) as string;
  const feeRouterAddr = (await registry.getModuleOrRevert(key("FEE_ROUTER"))) as string;
  const priceOracleAddr = (await registry.getModuleOrRevert(key("PRICE_ORACLE"))) as string;

  const acm = await ethers.getContractAt(
    [
      "function hasRole(bytes32,address) view returns (bool)",
      "function grantRole(bytes32,address)",
    ],
    acmAddr,
  );
  const awRead = await ethers.getContractAt(["function isAssetAllowed(address) view returns (bool)"], awAddr);
  const awAdmin = await ethers.getContractAt(["function addAllowedAsset(address)"] , awAddr);
  const feeRouter = await ethers.getContractAt(
    [
      "function isTokenSupported(address) view returns (bool)",
      "function addSupportedToken(address)",
    ],
    feeRouterAddr,
  );
  const priceOracle = await ethers.getContractAt(
    [
      "function getAssetConfig(address) view returns (tuple(string sourceId,uint256 assetDecimals,bool isActive,uint256 maxPriceAgeBlocks))",
      "function configureAsset(address,string,uint256,uint256)",
      "function setAssetActive(address,bool)",
    ],
    priceOracleAddr,
  );

  await ensureRole(acm, "SET_PARAMETER", deployer.address);
  await ensureRole(acm, "ADD_WHITELIST", deployer.address);

  // 对齐 Registry 里的结算币，避免后续 warmup 在错误的 settlement token 上运行。
  const currentSettlementToken = (await registry.getModule(key("SETTLEMENT_TOKEN"))) as string;
  if (currentSettlementToken.toLowerCase() !== settlementAsset.address.toLowerCase()) {
    await (await registry.setModule(key("SETTLEMENT_TOKEN"), settlementAsset.address)).wait();
  }

  for (const asset of [settlementAsset, collateralAsset]) {
    await ensureAllowed(awRead, awAdmin.connect(deployer), asset.address);
    await ensureFeeSupported(feeRouter.connect(deployer), asset.address);
    await ensureConfiguredWithoutPrice(priceOracle.connect(deployer), asset);
  }

  const settlementConfig = await priceOracle.getAssetConfig(settlementAsset.address);
  const collateralConfig = await priceOracle.getAssetConfig(collateralAsset.address);

  console.log(`Network=${network.name}`);
  console.log(`Registry=${registryAddr}`);
  console.log(`SettlementToken=${settlementAsset.address}`);
  console.log(`CollateralAsset=${collateralAsset.symbol}@${collateralAsset.address}`);
  console.log(`SettlementConfigActive=${String(settlementConfig.isActive ?? settlementConfig[2])}`);
  console.log(`CollateralConfigActive=${String(collateralConfig.isActive ?? collateralConfig[2])}`);
  console.log("Prices intentionally not seeded");
  console.log("✅ prepare-backend-required-block-local PASSED");
}

main().catch((error) => {
  console.error("\n❌ prepare-backend-required-block-local FAILED\n");
  console.error(error);
  process.exit(1);
});