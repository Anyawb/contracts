import fs from "fs";
import path from "path";
import { ethers, network } from "hardhat";

type AssetKind = "mock-erc20" | "rwa-token";

type PriceCatalogMetadata = {
  sourceProvider?: string;
  sourceTicker?: string;
  pricingCurrency?: string;
  quoteToUsdPair?: string;
  updateCadence?: string;
  staleAfterSeconds?: number;
  fallbackPolicy?: string;
  launchPriceRequired?: boolean;
};

type AssetSpec = {
  id: string;
  name: string;
  symbol: string;
  kind: AssetKind;
  decimals: number;
  initialSupply: string;
  sourceId: string;
  maxPriceAge: number;
  active: boolean;
  bootstrapPriceValue: string;
  settlementToken?: boolean;
} & PriceCatalogMetadata;

type DeployedAsset = AssetSpec & {
  address: string;
};

type DeployOutput = {
  network: string;
  chainId: number;
  deployer: string;
  deployedAt: string;
  settlementToken: string;
  assets: DeployedAsset[];
};

const DEFAULT_ASSET_SPECS: AssetSpec[] = [
  {
    id: "mock-usdc",
    name: "Mock USDC",
    symbol: "mUSDC",
    kind: "mock-erc20",
    decimals: 6,
    initialSupply: "1000000000",
    sourceId: "mock-usdc",
    maxPriceAge: 3600,
    active: true,
    bootstrapPriceValue: "1",
    sourceProvider: "bootstrap-manual",
    pricingCurrency: "USD",
    fallbackPolicy: "bootstrap-only",
    launchPriceRequired: false,
    settlementToken: true,
  },
  {
    id: "mock-usdt",
    name: "Mock USDT",
    symbol: "mUSDT",
    kind: "mock-erc20",
    decimals: 6,
    initialSupply: "1000000000",
    sourceId: "mock-usdt",
    maxPriceAge: 3600,
    active: true,
    bootstrapPriceValue: "1",
    sourceProvider: "bootstrap-manual",
    pricingCurrency: "USD",
    fallbackPolicy: "bootstrap-only",
    launchPriceRequired: false,
  },
  {
    id: "mock-hkd",
    name: "Mock HKD",
    symbol: "mHKD",
    kind: "mock-erc20",
    decimals: 18,
    initialSupply: "1000000000",
    sourceId: "mock-hkd",
    maxPriceAge: 3600,
    active: true,
    bootstrapPriceValue: "0.128",
    sourceProvider: "bootstrap-manual",
    pricingCurrency: "USD",
    fallbackPolicy: "bootstrap-only",
    launchPriceRequired: false,
  },
  {
    id: "mock-sgd",
    name: "Mock SGD",
    symbol: "mSGD",
    kind: "mock-erc20",
    decimals: 18,
    initialSupply: "1000000000",
    sourceId: "mock-sgd",
    maxPriceAge: 3600,
    active: true,
    bootstrapPriceValue: "0.74",
    sourceProvider: "bootstrap-manual",
    pricingCurrency: "USD",
    fallbackPolicy: "bootstrap-only",
    launchPriceRequired: false,
  },
  {
    id: "mock-btc",
    name: "Mock BTC",
    symbol: "mBTC",
    kind: "mock-erc20",
    decimals: 8,
    initialSupply: "21000000",
    sourceId: "mock-bitcoin",
    maxPriceAge: 3600,
    active: true,
    bootstrapPriceValue: "85000",
    sourceProvider: "bootstrap-manual",
    pricingCurrency: "USD",
    fallbackPolicy: "bootstrap-only",
    launchPriceRequired: false,
  },
  {
    id: "mock-eth",
    name: "Mock ETH",
    symbol: "mETH",
    kind: "mock-erc20",
    decimals: 18,
    initialSupply: "1000000",
    sourceId: "mock-ethereum",
    maxPriceAge: 3600,
    active: true,
    bootstrapPriceValue: "2200",
    sourceProvider: "bootstrap-manual",
    pricingCurrency: "USD",
    fallbackPolicy: "bootstrap-only",
    launchPriceRequired: false,
  },
  {
    id: "rwa-gold",
    name: "RWA Gold",
    symbol: "RWAGOLD",
    kind: "rwa-token",
    decimals: 18,
    initialSupply: "1000000",
    sourceId: "mock-rwa-gold",
    maxPriceAge: 3600,
    active: true,
    bootstrapPriceValue: "2000",
    sourceProvider: "google-finance",
    sourceTicker: "GLD:NYSEARCA",
    pricingCurrency: "USD",
    quoteToUsdPair: "USD/USD",
    updateCadence: "15m",
    staleAfterSeconds: 3600,
    fallbackPolicy: "backend-required-at-launch",
    launchPriceRequired: true,
  },
  {
    id: "rwa-bond",
    name: "RWA Bond",
    symbol: "RWABOND",
    kind: "rwa-token",
    decimals: 18,
    initialSupply: "1000000",
    sourceId: "mock-rwa-bond",
    maxPriceAge: 3600,
    active: true,
    bootstrapPriceValue: "100",
    sourceProvider: "google-finance",
    sourceTicker: "IEF:NASDAQ",
    pricingCurrency: "USD",
    quoteToUsdPair: "USD/USD",
    updateCadence: "30m",
    staleAfterSeconds: 7200,
    fallbackPolicy: "backend-required-at-launch",
    launchPriceRequired: true,
  },
  {
    id: "rwa-real-estate",
    name: "RWA Real Estate",
    symbol: "RWARE",
    kind: "rwa-token",
    decimals: 18,
    initialSupply: "1000000",
    sourceId: "mock-rwa-real-estate",
    maxPriceAge: 3600,
    active: true,
    bootstrapPriceValue: "500",
    sourceProvider: "google-finance",
    sourceTicker: "VNQ:NYSEARCA",
    pricingCurrency: "USD",
    quoteToUsdPair: "USD/USD",
    updateCadence: "1h",
    staleAfterSeconds: 14400,
    fallbackPolicy: "backend-required-at-launch",
    launchPriceRequired: true,
  },
  {
    id: "rwa-invoice",
    name: "RWA Invoice",
    symbol: "RWAINV",
    kind: "rwa-token",
    decimals: 18,
    initialSupply: "1000000",
    sourceId: "mock-rwa-invoice",
    maxPriceAge: 3600,
    active: true,
    bootstrapPriceValue: "50",
    sourceProvider: "google-finance",
    sourceTicker: "MINT:NYSEARCA",
    pricingCurrency: "USD",
    quoteToUsdPair: "USD/USD",
    updateCadence: "1h",
    staleAfterSeconds: 14400,
    fallbackPolicy: "backend-required-at-launch",
    launchPriceRequired: true,
  },
];

function networkSlug(name: string) {
  if (name === "arbitrumSepolia") return "arbitrum-sepolia";
  if (name === "bnbTestnet") return "bnb-testnet";
  return name;
}

function resolvePackOutputFile(slug: string) {
  const explicit = process.env.MOCK_ASSET_PACK_OUTPUT?.trim();
  if (explicit) {
    return path.isAbsolute(explicit)
      ? explicit
      : path.join(process.cwd(), explicit);
  }

  return path.join(process.cwd(), "deployments", `mock-assets.${slug}.json`);
}

function resolveAssetsOutputFile(slug: string) {
  const explicit = process.env.ASSETS_FILE?.trim();
  if (explicit) {
    return path.isAbsolute(explicit)
      ? explicit
      : path.join(process.cwd(), explicit);
  }

  return path.join(process.cwd(), "deployments", `assets.${slug}.mock.json`);
}

function applyDefaultSettlementTokenSelection(raw: AssetSpec[]): AssetSpec[] {
  const settlementSymbol = process.env.MOCK_SETTLEMENT_TOKEN_SYMBOL?.trim();
  if (!settlementSymbol) {
    return raw;
  }

  const normalized = settlementSymbol.toLowerCase();
  let matched = false;
  const updated = raw.map((item) => {
    const isSelected = item.symbol.toLowerCase() === normalized;
    if (isSelected) matched = true;
    return {
      ...item,
      settlementToken: isSelected,
    };
  });

  if (!matched) {
    throw new Error(
      `MOCK_SETTLEMENT_TOKEN_SYMBOL=${settlementSymbol} 未匹配默认资产包中的 symbol`,
    );
  }

  return updated;
}

function normalizeSpecs(raw: AssetSpec[]): AssetSpec[] {
  const specs = raw.map((item) => ({
    ...item,
    bootstrapPriceValue: (item as AssetSpec & { defaultPriceValue?: string }).bootstrapPriceValue
      ?? (item as AssetSpec & { defaultPriceValue?: string }).defaultPriceValue
      ?? "0",
    sourceProvider: item.sourceProvider ?? (item.kind === "rwa-token" ? "google-finance" : "bootstrap-manual"),
    pricingCurrency: item.pricingCurrency ?? "USD",
    fallbackPolicy: item.fallbackPolicy ?? (item.kind === "rwa-token" ? "backend-required-at-launch" : "bootstrap-only"),
    launchPriceRequired: item.launchPriceRequired ?? item.kind === "rwa-token",
    settlementToken: Boolean(item.settlementToken),
  }));
  const settlementCount = specs.filter((item) => item.settlementToken).length;
  if (settlementCount !== 1) {
    throw new Error(
      `mock asset pack 必须且只能定义一个 settlementToken，当前数量=${settlementCount}`,
    );
  }
  return specs;
}

function loadAssetSpecs(): AssetSpec[] {
  const file = process.env.MOCK_ASSET_PACK_FILE?.trim();
  if (!file) return normalizeSpecs(applyDefaultSettlementTokenSelection(DEFAULT_ASSET_SPECS));
  const resolved = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) as {
    assets?: AssetSpec[];
  };
  if (!parsed.assets?.length) {
    throw new Error(`MOCK_ASSET_PACK_FILE=${resolved} 未提供 assets 数组`);
  }
  return normalizeSpecs(parsed.assets);
}

async function deployAsset(spec: AssetSpec): Promise<string> {
  if (spec.kind === "mock-erc20") {
    const factory = await ethers.getContractFactory("MockERC20");
    const initialSupply = ethers.parseUnits(spec.initialSupply, spec.decimals);
    const contract = await factory.deploy(
      spec.name,
      spec.symbol,
      spec.decimals,
      initialSupply,
    );
    await contract.waitForDeployment();
    return await contract.getAddress();
  }

  if (spec.kind === "rwa-token") {
    const factory = await ethers.getContractFactory("RWAToken");
    const contract = await factory.deploy(spec.name, spec.symbol);
    await contract.waitForDeployment();
    const address = await contract.getAddress();
    const initialSupply = ethers.parseUnits(spec.initialSupply, spec.decimals);
    await (await contract.mint((await ethers.getSigners())[0].address, initialSupply)).wait();
    return address;
  }

  throw new Error(`unsupported asset kind: ${String(spec.kind)}`);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const slug = networkSlug(network.name);
  const specs = loadAssetSpecs();

  const deployedAssets: DeployedAsset[] = [];
  for (const spec of specs) {
    console.log(`🚀 Deploying ${spec.name} (${spec.symbol}) ...`);
    const address = await deployAsset(spec);
    deployedAssets.push({
      ...spec,
      address,
    });
    console.log(`✅ ${spec.symbol} deployed @ ${address}`);
  }

  const settlement = deployedAssets.find((asset) => asset.settlementToken);
  if (!settlement) {
    throw new Error("未找到 settlementToken 资产");
  }

  const output: DeployOutput = {
    network: slug,
    chainId,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    settlementToken: settlement.address,
    assets: deployedAssets,
  };

  const packFile = resolvePackOutputFile(slug);
  const assetsFile = resolveAssetsOutputFile(slug);
  fs.mkdirSync(path.dirname(packFile), { recursive: true });
  fs.mkdirSync(path.dirname(assetsFile), { recursive: true });
  fs.writeFileSync(packFile, JSON.stringify(output, null, 2));

  fs.writeFileSync(
    assetsFile,
    JSON.stringify(
      {
        network: slug,
        chainId,
        assets: deployedAssets.map((asset) => ({
          address: asset.address,
          oracleAssetKey: asset.sourceId,
          sourceId: asset.sourceId,
          decimals: asset.decimals,
          maxPriceAge: asset.maxPriceAge,
          active: asset.active,
          bootstrapPriceValue: asset.bootstrapPriceValue,
          sourceProvider: asset.sourceProvider,
          sourceTicker: asset.sourceTicker,
          pricingCurrency: asset.pricingCurrency,
          quoteToUsdPair: asset.quoteToUsdPair,
          updateCadence: asset.updateCadence,
          staleAfterSeconds: asset.staleAfterSeconds,
          fallbackPolicy: asset.fallbackPolicy,
          launchPriceRequired: asset.launchPriceRequired,
        })),
      },
      null,
      2,
    ),
  );

  console.log("\n=== Mock Asset Pack Ready ===");
  console.log(`Network=${slug}`);
  console.log(`Deployer=${deployer.address}`);
  console.log(`SettlementToken=${settlement.address}`);
  console.log(`AssetPackFile=${packFile}`);
  console.log(`AssetsConfigFile=${assetsFile}`);
  console.log("Bootstrap prices (asset-decimal strings):");
  for (const asset of deployedAssets) {
    console.log(`- ${asset.symbol}: ${asset.bootstrapPriceValue}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});