import fs from "fs";
import path from "path";
import { ethers, network } from "hardhat";
import { configureDynamicEip1559Fees } from "../utils/eip1559-fees";

type MockAssetPack = {
  settlementToken: string;
  assets: Array<{
    symbol: string;
    address: string;
    decimals: number;
    bootstrapPriceValue?: string;
    defaultPriceValue?: string;
  }>;
};

type SeedAsset = {
  symbol: string;
  address: string;
  decimals: number;
  bootstrapPriceValue?: string;
  defaultPriceValue?: string;
};

function getBootstrapPriceValue(asset: {
  bootstrapPriceValue?: string;
  defaultPriceValue?: string;
}) {
  return asset.bootstrapPriceValue ?? asset.defaultPriceValue ?? "0";
}

function key(name: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

const PRICE_UPDATER_REGISTRY_RAW_KEY = "COINGECKO_PRICE_UPDATER";

function networkSlug(name: string) {
  if (name === "arbitrumSepolia") return "arbitrum-sepolia";
  if (name === "bnbTestnet") return "bnb-testnet";
  return name;
}

function resolveDeployFile() {
  const explicit = process.env.DEPLOY_OUTPUT_FILE?.trim();
  if (explicit) {
    return path.isAbsolute(explicit)
      ? explicit
      : path.join(process.cwd(), explicit);
  }

  const slug = networkSlug(network.name);
  const candidates = [
    path.join(process.cwd(), "scripts", "deployments", `${slug}.json`),
    path.join(process.cwd(), "scripts", "deployments", slug, "core.json"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

function loadJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`invalid ${name}=${raw}`);
  }
  return value;
}

function resolvePackFile() {
  const explicit = process.env.MOCK_ASSET_PACK_OUTPUT?.trim();
  if (explicit) {
    return path.isAbsolute(explicit)
      ? explicit
      : path.join(process.cwd(), explicit);
  }
  return path.join(
    process.cwd(),
    "deployments",
    `mock-assets.${networkSlug(network.name)}.json`,
  );
}

function resolveRegistryAddress(): string {
  const explicit = process.env.REGISTRY_ADDRESS?.trim();
  if (explicit) return explicit;

  const deployFile = resolveDeployFile();
  if (!fs.existsSync(deployFile)) {
    throw new Error(
      `缺少 REGISTRY_ADDRESS，且未找到部署输出文件 ${deployFile}`,
    );
  }
  const parsed = loadJson(deployFile) as Record<string, string>;
  if (!parsed.Registry) {
    throw new Error(`部署输出文件 ${deployFile} 中缺少 Registry 地址`);
  }
  return parsed.Registry;
}

async function main() {
  await configureDynamicEip1559Fees({
    ethers,
    networkName: network.name,
    label: "seed-mock-asset-prices",
  });
  const [deployer] = await ethers.getSigners();
  const registryAddr = resolveRegistryAddress();
  const packFile = resolvePackFile();
  const pack = loadJson(packFile) as MockAssetPack;

  const registry = await ethers.getContractAt(
    [
      "function getModuleOrRevert(bytes32) view returns (address)",
    ],
    registryAddr,
  );
  const acmAddr = (await registry.getModuleOrRevert(
    key("ACCESS_CONTROL_MANAGER"),
  )) as string;
  const priceOracleAddr = (await registry.getModuleOrRevert(
    key("PRICE_ORACLE"),
  )) as string;
  const updaterAddr = (await registry.getModuleOrRevert(
    key(PRICE_UPDATER_REGISTRY_RAW_KEY),
  )) as string;
  const settlementTokenAddr = (await registry.getModuleOrRevert(
    key("SETTLEMENT_TOKEN"),
  )) as string;

  const acm = await ethers.getContractAt(
    [
      "function owner() view returns (address)",
      "function hasRole(bytes32 role,address account) view returns (bool)",
      "function grantRole(bytes32 role,address account)",
    ],
    acmAddr,
  );
  const priceOracle = await ethers.getContractAt(
    [
      "function updatePrice(address asset,uint256 price,uint256 blockNumber)",
    ],
    priceOracleAddr,
  );
  const updater = await ethers.getContractAt(
    [
      "function updateAssetPrice(address asset,uint256 price,uint256 blockNumber)",
    ],
    updaterAddr,
  );

  const updatePriceRole = key("UPDATE_PRICE");
  const hasUpdatePrice = (await acm.hasRole(
    updatePriceRole,
    deployer.address,
  )) as boolean;
  const acmOwner = ((await acm.owner()) as string).toLowerCase();
  const autoGrant = (process.env.AUTO_GRANT_UPDATE_PRICE?.trim() || "") === "1";
  const allowDirectOracle = (process.env.SEED_ALLOW_DIRECT_PRICE_ORACLE?.trim() || "") === "1";

  if (!hasUpdatePrice) {
    if (!autoGrant || acmOwner !== deployer.address.toLowerCase()) {
      throw new Error(
        "deployer 缺少 UPDATE_PRICE，若当前 deployer 同时是 ACM owner，可使用 AUTO_GRANT_UPDATE_PRICE=1 自动授权",
      );
    }
    await (await acm.grantRole(updatePriceRole, deployer.address)).wait();
    console.log(`✅ Granted UPDATE_PRICE to ${deployer.address}`);
  }

  const blockNumber = await ethers.provider.getBlockNumber();
  const seedAssets: SeedAsset[] = [...pack.assets];
  const hasProtocolSettlement = seedAssets.some(
    (asset) => asset.address.toLowerCase() === settlementTokenAddr.toLowerCase(),
  );
  if (!hasProtocolSettlement) {
    seedAssets.unshift({
      symbol: process.env.SETTLEMENT_TOKEN_SYMBOL?.trim() || "SETTLEMENT",
      address: settlementTokenAddr,
      decimals: envInt("SETTLEMENT_TOKEN_DECIMALS", 18),
      bootstrapPriceValue: process.env.SETTLEMENT_PRICE_VALUE?.trim() || "1",
      defaultPriceValue: process.env.SETTLEMENT_PRICE_VALUE?.trim() || "1",
    });
  }

  console.log(`Registry=${registryAddr}`);
  console.log(`PriceOracle=${priceOracleAddr}`);
  console.log(`PriceUpdater=${updaterAddr}`);
  console.log(`PriceUpdaterRegistryKey=PRICE_UPDATER (compat raw: ${PRICE_UPDATER_REGISTRY_RAW_KEY})`);
  console.log(`ProtocolSettlementToken=${settlementTokenAddr}`);
  console.log(`MockAssetPack=${packFile}`);
  console.log(`SeedBlock=${blockNumber}`);
  console.log(`SeedRoute=${allowDirectOracle ? "PriceOracle.updatePrice (break-glass)" : "PriceUpdater.updateAssetPrice"}`);

  for (const asset of seedAssets) {
    const bootstrapPriceValue = getBootstrapPriceValue(asset);
    const price = ethers.parseUnits(bootstrapPriceValue, asset.decimals);
    if (allowDirectOracle) {
      await (await priceOracle.updatePrice(asset.address, price, blockNumber)).wait();
      console.log(`✅ Seeded ${asset.symbol} @ ${asset.address} => ${bootstrapPriceValue} price-value(decimals=${asset.decimals}) via PriceOracle.updatePrice`);
    } else {
      await (await updater.updateAssetPrice(asset.address, price, blockNumber)).wait();
      console.log(`✅ Seeded ${asset.symbol} @ ${asset.address} => ${bootstrapPriceValue} price-value(decimals=${asset.decimals}) via PriceUpdater.updateAssetPrice`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});