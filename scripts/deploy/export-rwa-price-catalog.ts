import fs from "fs";
import path from "path";
import { network } from "hardhat";

type MockAssetPackAsset = {
  id: string;
  name: string;
  symbol: string;
  kind: "mock-erc20" | "rwa-token";
  decimals: number;
  initialSupply: string;
  sourceId: string;
  maxPriceAge: number;
  active: boolean;
  bootstrapPriceValue?: string;
  defaultPriceValue?: string;
  sourceProvider?: string;
  sourceTicker?: string;
  pricingCurrency?: string;
  quoteToUsdPair?: string;
  updateCadence?: string;
  staleAfterSeconds?: number;
  fallbackPolicy?: string;
  launchPriceRequired?: boolean;
  settlementToken?: boolean;
  address: string;
};

type MockAssetPack = {
  network: string;
  chainId: number;
  settlementToken: string;
  assets: MockAssetPackAsset[];
};

function networkSlug(name: string) {
  return name === "arbitrumSepolia" ? "arbitrum-sepolia" : name;
}

function getBootstrapPriceValue(asset: MockAssetPackAsset) {
  return asset.bootstrapPriceValue ?? asset.defaultPriceValue ?? "0";
}

function getDefaultCatalogMetadata(asset: MockAssetPackAsset) {
  switch (asset.symbol) {
    case "RWAGOLD":
      return {
        sourceProvider: "google-finance",
        sourceTicker: "GLD:NYSEARCA",
        pricingCurrency: "USD",
        quoteToUsdPair: "USD/USD",
        updateCadence: "15m",
        staleAfterSeconds: 3600,
        fallbackPolicy: "backend-required-at-launch",
        launchPriceRequired: true,
      };
    case "RWABOND":
      return {
        sourceProvider: "google-finance",
        sourceTicker: "IEF:NASDAQ",
        pricingCurrency: "USD",
        quoteToUsdPair: "USD/USD",
        updateCadence: "30m",
        staleAfterSeconds: 7200,
        fallbackPolicy: "backend-required-at-launch",
        launchPriceRequired: true,
      };
    case "RWARE":
      return {
        sourceProvider: "google-finance",
        sourceTicker: "VNQ:NYSEARCA",
        pricingCurrency: "USD",
        quoteToUsdPair: "USD/USD",
        updateCadence: "1h",
        staleAfterSeconds: 14400,
        fallbackPolicy: "backend-required-at-launch",
        launchPriceRequired: true,
      };
    case "RWAINV":
      return {
        sourceProvider: "google-finance",
        sourceTicker: "MINT:NYSEARCA",
        pricingCurrency: "USD",
        quoteToUsdPair: "USD/USD",
        updateCadence: "1h",
        staleAfterSeconds: 14400,
        fallbackPolicy: "backend-required-at-launch",
        launchPriceRequired: true,
      };
    default:
      return {
        sourceProvider: asset.sourceProvider ?? "google-finance",
        sourceTicker: asset.sourceTicker ?? asset.symbol,
        pricingCurrency: asset.pricingCurrency ?? "USD",
        quoteToUsdPair: asset.quoteToUsdPair ?? "USD/USD",
        updateCadence: asset.updateCadence ?? "1h",
        staleAfterSeconds: asset.staleAfterSeconds ?? 14400,
        fallbackPolicy: asset.fallbackPolicy ?? "backend-required-at-launch",
        launchPriceRequired: asset.launchPriceRequired ?? true,
      };
  }
}

function getPublishMode(asset: MockAssetPackAsset) {
  const defaults = getDefaultCatalogMetadata(asset);
  const launchPriceRequired = asset.launchPriceRequired ?? defaults.launchPriceRequired;
  return launchPriceRequired ? "backend-required" : "bootstrap";
}

function resolveCatalogSource(asset: MockAssetPackAsset) {
  const defaults = getDefaultCatalogMetadata(asset);
  return {
    provider: asset.sourceProvider ?? defaults.sourceProvider,
    ticker: asset.sourceTicker ?? defaults.sourceTicker,
    pricingCurrency: asset.pricingCurrency ?? defaults.pricingCurrency,
    quoteToUsdPair: asset.quoteToUsdPair ?? defaults.quoteToUsdPair,
  };
}

function resolveCadence(asset: MockAssetPackAsset) {
  const defaults = getDefaultCatalogMetadata(asset);
  return {
    updateCadence: asset.updateCadence ?? defaults.updateCadence,
    staleAfterSeconds: asset.staleAfterSeconds ?? defaults.staleAfterSeconds,
  };
}

function resolveInputFile(slug: string) {
  const explicit = process.env.MOCK_ASSET_PACK_OUTPUT?.trim();
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.join(process.cwd(), explicit);
  }
  return path.join(process.cwd(), "deployments", `mock-assets.${slug}.json`);
}

function resolveOutputFile(slug: string) {
  const explicit = process.env.RWA_PRICE_CATALOG_OUTPUT?.trim();
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.join(process.cwd(), explicit);
  }
  return path.join(process.cwd(), "deployments", `rwa-price-catalog.${slug}.json`);
}

async function main() {
  const slug = networkSlug(network.name);
  const inputFile = resolveInputFile(slug);
  const outputFile = resolveOutputFile(slug);

  if (!fs.existsSync(inputFile)) {
    throw new Error(`mock asset pack not found: ${inputFile}`);
  }

  const pack = JSON.parse(fs.readFileSync(inputFile, "utf8")) as MockAssetPack;
  const rwaAssets = pack.assets.filter((asset) => asset.kind === "rwa-token");
  if (rwaAssets.length === 0) {
    throw new Error(`no rwa-token assets found in ${inputFile}`);
  }

  const payload = {
    schemaVersion: 1,
    network: slug,
    chainId: pack.chainId,
    generatedAt: new Date().toISOString(),
    sourcePack: path.relative(process.cwd(), inputFile),
    targetPriceUnit: "asset-decimals",
    defaultWriteTarget: "PriceUpdater.updateAssetPrice",
    rwaAssetCatalog: rwaAssets.map((asset) => {
      const source = resolveCatalogSource(asset);
      const cadence = resolveCadence(asset);
      return {
        assetId: asset.id,
        symbol: asset.symbol,
        address: asset.address,
        updaterAssetId: asset.sourceId,
        publishMode: getPublishMode(asset),
        source,
        bootstrapPriceValue: getBootstrapPriceValue(asset),
        updateCadence: cadence.updateCadence,
        staleAfterSeconds: cadence.staleAfterSeconds,
      };
    }),
    oraclePublishJobs: rwaAssets.map((asset) => {
      const source = resolveCatalogSource(asset);
      const cadence = resolveCadence(asset);
      return {
        jobId: `publish-${asset.symbol.toLowerCase()}`,
        assetId: asset.id,
        symbol: asset.symbol,
        address: asset.address,
        updaterAssetId: asset.sourceId,
        publishMode: getPublishMode(asset),
        writeTarget: "PriceUpdater.updateAssetPrice",
        enabled: true,
        bootstrapPriceValue: getBootstrapPriceValue(asset),
        targetPriceUnit: "asset-decimals",
        source,
        updateCadence: cadence.updateCadence,
        staleAfterSeconds: cadence.staleAfterSeconds,
      };
    }),
  };

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(payload, null, 2));

  console.log("=== RWA Backend Export Ready ===");
  console.log(`Input=${inputFile}`);
  console.log(`Output=${outputFile}`);
  console.log(`RwaAssets=${rwaAssets.length}`);
  for (const asset of rwaAssets) {
    console.log(
      `- ${asset.symbol}: ${asset.sourceProvider ?? "google-finance"} ${asset.sourceTicker ?? asset.symbol} -> ${asset.sourceId}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});