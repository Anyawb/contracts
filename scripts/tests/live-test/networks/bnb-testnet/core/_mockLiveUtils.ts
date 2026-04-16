import fs from "fs";
import path from "path";
import { ethers, network } from "hardhat";
import type { Interface, TypedDataField } from "ethers";

import { envBool, envStr } from "../../../../_addressResolver";
import { decodeRevert } from "../../../../../utils/decodeRevert";

export type MockAssetPackAsset = {
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
  bootstrapPriceUsd8?: string;
  defaultPriceValue?: string;
  defaultPriceUsd8?: string;
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

export type MockAssetPack = {
  settlementToken: string;
  assets: MockAssetPackAsset[];
};

export type SelectedMockAssets = {
  packFile: string;
  settlementAsset: MockAssetPackAsset;
  borrowAsset: MockAssetPackAsset;
  collateralAsset: MockAssetPackAsset;
  selectionSource: string[];
};

export type LivePriceMode = "bootstrap" | "backend-required";

function envStrWithLegacy(name: string, legacyName?: string): string | undefined {
  const primary = envStr(name);
  if (primary) return primary;
  if (!legacyName) return undefined;
  return envStr(legacyName);
}

function resolveWorkerIndex() {
  const raw = envStr("LIVE_WORKER_INDEX")?.trim() ?? envStr("LIVE_WORKER_ID")?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.floor(parsed);
}

function envStrForWorker(baseName: string): string | undefined {
  const workerIndex = resolveWorkerIndex();
  if (workerIndex === null) {
    return envStr(baseName);
  }

  const directCandidates = [
    `${baseName}_WORKER_${workerIndex}`,
    `${baseName}_${workerIndex}`,
    `${baseName}_${workerIndex + 1}`,
  ];
  for (const candidate of directCandidates) {
    const value = envStr(candidate)?.trim();
    if (value) {
      return value;
    }
  }

  const list = envStr(`${baseName}_LIST`)
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (list && list.length > 0) {
    const picked = list[workerIndex % list.length];
    if (picked) {
      return picked;
    }
  }

  return envStr(baseName);
}

// 价格字段统一按 asset.decimals 表达。
export function getAssetBootstrapPriceValue(asset: MockAssetPackAsset) {
  return asset.bootstrapPriceValue
    ?? asset.bootstrapPriceUsd8
    ?? asset.defaultPriceValue
    ?? asset.defaultPriceUsd8
    ?? "0";
}

export function parseAssetBootstrapPrice(asset: MockAssetPackAsset) {
  return ethers.parseUnits(getAssetBootstrapPriceValue(asset), asset.decimals);
}

// 统一解析 live 价格模式：
// bootstrap 允许在缺最终价格时用启动价兜底；backend-required 则要求后端已完成正式发布。
export function getLivePriceMode(defaultMode: LivePriceMode = "bootstrap"): LivePriceMode {
  const raw = envStr("LIVE_PRICE_MODE")?.trim().toLowerCase();
  if (!raw) {
    return defaultMode;
  }
  if (raw === "bootstrap" || raw === "backend-required") {
    return raw;
  }
  throw new Error(
    `unsupported LIVE_PRICE_MODE=${raw}. expected bootstrap or backend-required`,
  );
}

// 仅用于日志，把资产价格目录里的来源/更新策略打印完整，便于定位价格配置问题。
export function describePriceCatalog(asset: Pick<
  MockAssetPackAsset,
  | "sourceId"
  | "sourceProvider"
  | "sourceTicker"
  | "pricingCurrency"
  | "quoteToUsdPair"
  | "updateCadence"
  | "staleAfterSeconds"
  | "fallbackPolicy"
  | "launchPriceRequired"
>) {
  const fields = [
    `oracleAssetKey=${asset.sourceId}`,
    asset.sourceProvider ? `sourceProvider=${asset.sourceProvider}` : null,
    asset.sourceTicker ? `sourceTicker=${asset.sourceTicker}` : null,
    asset.pricingCurrency ? `pricingCurrency=${asset.pricingCurrency}` : null,
    asset.quoteToUsdPair ? `quoteToUsdPair=${asset.quoteToUsdPair}` : null,
    asset.updateCadence ? `updateCadence=${asset.updateCadence}` : null,
    asset.staleAfterSeconds !== undefined ? `staleAfterSeconds=${asset.staleAfterSeconds}` : null,
    asset.fallbackPolicy ? `fallbackPolicy=${asset.fallbackPolicy}` : null,
    asset.launchPriceRequired !== undefined ? `launchPriceRequired=${asset.launchPriceRequired}` : null,
  ].filter(Boolean);

  return fields.join(" ");
}

export type LiveObservation = {
  debtAssetPrice: bigint;
  debtAssetPriceBlock: bigint;
  debtAssetPriceValid: boolean;
  collateralPrice: bigint;
  collateralPriceBlock: bigint;
  collateralPriceValid: boolean;
  debtAssetSystemValid: boolean;
  debtAssetSystemUpdateBlock: bigint;
  debtAssetTotalCollateral: bigint;
  debtAssetTotalDebt: bigint;
  collateralSystemValid: boolean;
  collateralSystemUpdateBlock: bigint;
  collateralTotalCollateral: bigint;
  collateralTotalDebt: bigint;
  borrowerRewardBlock: bigint;
  borrowerRewardValid: boolean;
  borrowerPendingPenalty: bigint;
  borrowerEasyEarned: bigint;
  borrowerEasyEarnedBlock: bigint;
  borrowerEasyEarnedValid: boolean;
  lenderRewardBlock: bigint;
  lenderRewardValid: boolean;
  lenderPendingPenalty: bigint;
  lenderEasyEarned: bigint;
  lenderEasyEarnedBlock: bigint;
  lenderEasyEarnedValid: boolean;
  borrowerHealth: bigint;
  borrowerHealthValid: boolean;
  borrowerHealthBlock: bigint;
  collateralPositionCollateral: bigint;
  collateralPositionDebt: bigint;
  collateralPositionValid: boolean;
  collateralPositionBlock: bigint;
  collateralPositionAge: bigint;
  debtPositionCollateral: bigint;
  debtPositionDebt: bigint;
  debtPositionValid: boolean;
  debtPositionBlock: bigint;
  debtPositionAge: bigint;
};

export const BORROW_INTENT_TYPES = {
  BorrowIntent: [
    { name: "borrower", type: "address" },
    { name: "collateralAsset", type: "address" },
    { name: "collateralAmount", type: "uint256" },
    { name: "borrowAsset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "termDays", type: "uint16" },
    { name: "rateBps", type: "uint256" },
    { name: "expireAt", type: "uint256" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

export const LEND_INTENT_TYPES = {
  LendIntent: [
    { name: "lenderSigner", type: "address" },
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "minTermDays", type: "uint16" },
    { name: "maxTermDays", type: "uint16" },
    { name: "minRateBps", type: "uint256" },
    { name: "expireAt", type: "uint256" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

export function key(name: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

export function networkSlug(name: string) {
  const alias = envStr("LIVE_NETWORK_ALIAS");
  if ((name === "localhost" || name === "hardhat") && alias) {
    return networkSlug(alias);
  }
  if (name === "arbitrumSepolia") {
    return "arbitrum-sepolia";
  }
  if (name === "bnbTestnet") {
    return "bnb-testnet";
  }
  return name;
}

export function fmtErr(error: any) {
  return error?.shortMessage ?? error?.message ?? String(error);
}

// 测试允许通过环境变量切换 mock asset pack 输出文件，方便多套部署产物并行验证。
function resolvePackFile() {
  const explicit = envStr("MOCK_ASSET_PACK_OUTPUT");
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

// 当 pack 里找不到显式指定的资产时，退化为按环境变量拼一个临时资产定义。
function buildSyntheticAsset(params: {
  address: string;
  symbolEnv: string;
  sourceIdEnv: string;
  decimalsEnv: string;
  bootstrapPriceEnv: string;
  fallbackSymbol: string;
  fallbackDecimals: number;
  fallbackBootstrapPriceValue: string;
}): MockAssetPackAsset {
  const decimalsRaw = envStr(params.decimalsEnv);
  const decimals = decimalsRaw ? Number(decimalsRaw) : params.fallbackDecimals;
  if (!Number.isFinite(decimals)) {
    throw new Error(`invalid ${params.decimalsEnv}=${decimalsRaw}`);
  }

  return {
    id: `custom-${params.fallbackSymbol.toLowerCase()}`,
    name: envStr(params.symbolEnv) ?? params.fallbackSymbol,
    symbol: envStr(params.symbolEnv) ?? params.fallbackSymbol,
    kind: "mock-erc20",
    decimals,
    initialSupply: "0",
    sourceId: envStr(params.sourceIdEnv) ?? params.fallbackSymbol.toLowerCase(),
    maxPriceAge: 3600,
    active: true,
    bootstrapPriceValue: envStr(params.bootstrapPriceEnv) ?? params.fallbackBootstrapPriceValue,
    address: ethers.getAddress(params.address),
  };
}

export function loadMockAssetPackData(): { packFile: string; pack: MockAssetPack } {
  const packFile = resolvePackFile();
  const pack = JSON.parse(fs.readFileSync(packFile, "utf8")) as MockAssetPack;
  return { packFile, pack };
}

// 统一决定 settlement / borrow / collateral 三个角色分别选谁，
// 并把“为什么选到它”记录在 selectionSource 里，便于日志诊断。
export function loadMockAssetPack(): SelectedMockAssets {
  const { packFile, pack } = loadMockAssetPackData();
  const assets = pack.assets ?? [];
  if (assets.length === 0) {
    throw new Error(`mock asset pack is empty: ${packFile}`);
  }

  const sources: string[] = [];
  const settlementByEnv = envStr("SETTLEMENT_TOKEN_ADDRESS")?.toLowerCase();
  let settlementAsset = settlementByEnv
    ? assets.find((asset) => asset.address.toLowerCase() === settlementByEnv)
    : assets.find((asset) => asset.address.toLowerCase() === pack.settlementToken.toLowerCase());
  if (!settlementAsset && settlementByEnv) {
    settlementAsset = buildSyntheticAsset({
      address: settlementByEnv,
      symbolEnv: "SETTLEMENT_TOKEN_SYMBOL",
      sourceIdEnv: "SETTLEMENT_TOKEN_SOURCE_ID",
      decimalsEnv: "SETTLEMENT_TOKEN_DECIMALS",
      bootstrapPriceEnv: "SETTLEMENT_PRICE_VALUE",
      fallbackSymbol: "SETTLEMENT",
      fallbackDecimals: 18,
      fallbackBootstrapPriceValue: "1",
    });
  }
  if (!settlementAsset) {
    throw new Error(`unable to resolve settlement asset from mock pack: ${packFile}`);
  }
  sources.push(
    settlementByEnv
      ? `settlement from SETTLEMENT_TOKEN_ADDRESS=${settlementAsset.address}`
      : `settlement from pack=${settlementAsset.address}`,
  );

  const borrowAddress = envStr("BORROW_ASSET_ADDRESS")?.toLowerCase();
  const borrowSymbol = envStr("BORROW_SYMBOL")?.toLowerCase();
  const borrowSourceId = envStrWithLegacy("BORROW_SOURCE_ID", "BORROW_COINGECKO_ID")?.toLowerCase();

  let borrowAsset: MockAssetPackAsset | undefined;
  if (borrowAddress) {
    borrowAsset = assets.find((asset) => asset.address.toLowerCase() === borrowAddress);
    if (!borrowAsset) {
      borrowAsset = buildSyntheticAsset({
        address: borrowAddress,
        symbolEnv: "BORROW_SYMBOL",
        sourceIdEnv: "BORROW_SOURCE_ID",
        decimalsEnv: "BORROW_ASSET_DECIMALS",
        bootstrapPriceEnv: "BORROW_PRICE_VALUE",
        fallbackSymbol: "BORROW",
        fallbackDecimals: settlementAsset.decimals,
        fallbackBootstrapPriceValue: getAssetBootstrapPriceValue(settlementAsset),
      });
    }
    sources.push(`borrow from BORROW_ASSET_ADDRESS=${borrowAsset.address}`);
  }
  if (!borrowAsset && borrowSymbol) {
    borrowAsset = assets.find((asset) => asset.symbol.toLowerCase() === borrowSymbol);
    if (borrowAsset) sources.push(`borrow from BORROW_SYMBOL=${borrowAsset.symbol}`);
  }
  if (!borrowAsset && borrowSourceId) {
    borrowAsset = assets.find((asset) => asset.sourceId.toLowerCase() === borrowSourceId);
    if (borrowAsset) sources.push(`borrow from BORROW_SOURCE_ID=${borrowAsset.sourceId}`);
  }
  if (!borrowAsset) {
    borrowAsset = settlementAsset;
    sources.push(`borrow default settlement=${borrowAsset.symbol}`);
  }

  const collateralAddress = envStr("COLLATERAL_ASSET_ADDRESS")?.toLowerCase();
  const collateralSymbol = envStr("COLLATERAL_SYMBOL")?.toLowerCase();
  const collateralSourceId = envStrWithLegacy("COLLATERAL_SOURCE_ID", "COLLATERAL_COINGECKO_ID")?.toLowerCase();

  let collateralAsset: MockAssetPackAsset | undefined;
  if (collateralAddress) {
    collateralAsset = assets.find((asset) => asset.address.toLowerCase() === collateralAddress);
    if (collateralAsset) sources.push(`collateral from COLLATERAL_ASSET_ADDRESS=${collateralAsset.address}`);
  }
  if (!collateralAsset && collateralSymbol) {
    collateralAsset = assets.find((asset) => asset.symbol.toLowerCase() === collateralSymbol);
    if (collateralAsset) sources.push(`collateral from COLLATERAL_SYMBOL=${collateralAsset.symbol}`);
  }
  if (!collateralAsset && collateralSourceId) {
    collateralAsset = assets.find((asset) => asset.sourceId.toLowerCase() === collateralSourceId);
    if (collateralAsset) {
      sources.push(`collateral from COLLATERAL_SOURCE_ID=${collateralAsset.sourceId}`);
    }
  }
  if (!collateralAsset) {
    collateralAsset = assets.find(
      (asset) => asset.kind === "rwa-token" && asset.address.toLowerCase() !== borrowAsset.address.toLowerCase(),
    );
    if (collateralAsset) sources.push(`collateral default first rwa-token=${collateralAsset.symbol}`);
  }
  if (!collateralAsset) {
    collateralAsset = assets.find(
      (asset) => asset.address.toLowerCase() !== borrowAsset.address.toLowerCase(),
    );
    if (collateralAsset) sources.push(`collateral fallback first non-settlement asset=${collateralAsset.symbol}`);
  }
  if (!collateralAsset) {
    throw new Error("unable to resolve collateral asset from mock asset pack");
  }
  if (collateralAsset.address.toLowerCase() === borrowAsset.address.toLowerCase()) {
    throw new Error("collateral asset must be different from borrow asset for the mock live flow");
  }

  return {
    packFile,
    settlementAsset,
    borrowAsset,
    collateralAsset,
    selectionSource: sources,
  };
}

// borrower / lender 可以通过私钥切换成真实参与者；没给时默认退回 relayer。
export async function getActorSigner(label: string, pkEnv: string, fallbackSigner: any) {
  const pk = envStrForWorker(pkEnv);
  if (pk) {
    const signer = await withNonceManagedSigner(new ethers.Wallet(pk, ethers.provider));
    return {
      signer,
      source: pkEnv,
      label,
    };
  }

  const signer = await withNonceManagedSigner(fallbackSigner);
  return {
    signer,
    source: `fallback:${label}=relayer`,
    label,
  };
}

export function resolveBnbMinGasPriceWei() {
  const raw = process.env.LIVE_BNB_MIN_GAS_PRICE_WEI?.trim();
  if (!raw) {
    return 1_000_000_000n;
  }
  try {
    const parsed = BigInt(raw);
    return parsed > 0n ? parsed : 1_000_000_000n;
  } catch {
    return 1_000_000_000n;
  }
}

type NonceManagedSigner = {
  address?: string;
  getAddress(): Promise<string>;
  sendTransaction(tx: any): Promise<any>;
};

type SharedNonceState = {
  nextNonce?: number;
  queue: Promise<void>;
};

const sharedSignerNonceState = new Map<string, SharedNonceState>();

export async function withNonceManagedSigner<T extends NonceManagedSigner>(signer: T): Promise<T> {
  const address = signer.address ?? await signer.getAddress();
  const signerKey = address.toLowerCase();
  const baseSendTransaction = signer.sendTransaction.bind(signer);
  const applyNetworkFeeFloor = (tx: any) => {
    if (network.name !== "bnbTestnet") {
      return tx;
    }

    const minPriorityFeePerGas = resolveBnbMinGasPriceWei();
    if (tx?.gasPrice != null) {
      const gasPrice = BigInt(tx.gasPrice);
      return gasPrice >= minPriorityFeePerGas
        ? tx
        : { ...tx, gasPrice: minPriorityFeePerGas };
    }

    const maxPriorityFeePerGas = tx?.maxPriorityFeePerGas != null
      ? BigInt(tx.maxPriorityFeePerGas)
      : minPriorityFeePerGas;
    const flooredPriorityFeePerGas = maxPriorityFeePerGas >= minPriorityFeePerGas
      ? maxPriorityFeePerGas
      : minPriorityFeePerGas;
    const maxFeePerGas = tx?.maxFeePerGas != null
      ? BigInt(tx.maxFeePerGas)
      : flooredPriorityFeePerGas;
    const flooredMaxFeePerGas = maxFeePerGas >= flooredPriorityFeePerGas
      ? maxFeePerGas
      : flooredPriorityFeePerGas;

    return {
      ...tx,
      maxFeePerGas: flooredMaxFeePerGas,
      maxPriorityFeePerGas: flooredPriorityFeePerGas,
    };
  };
  const loadSuggestedNonce = async () => {
    const [latestNonce, pendingNonce] = await Promise.all([
      ethers.provider.getTransactionCount(address, "latest"),
      ethers.provider.getTransactionCount(address, "pending"),
    ]);
    return latestNonce > pendingNonce ? latestNonce : pendingNonce;
  };
  const sharedState = sharedSignerNonceState.get(signerKey) ?? { queue: Promise.resolve() };
  sharedSignerNonceState.set(signerKey, sharedState);
  const sendTransaction = async (tx: any) => {
    const releasePrevious = sharedState.queue.catch(() => undefined);
    let releaseQueue!: () => void;
    sharedState.queue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    await releasePrevious;

    try {
      const sendWithNonce = async (nonce: number) => {
        const preparedTx = {
          ...applyNetworkFeeFloor(tx),
          nonce,
        };
        const sentTx = await baseSendTransaction(preparedTx);
        sharedState.nextNonce = nonce + 1;
        return sentTx;
      };

      const requestedNonce = tx?.nonce;
      let nextAttemptNonce = requestedNonce ?? sharedState.nextNonce ?? await loadSuggestedNonce();
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await sendWithNonce(nextAttemptNonce);
        } catch (error: any) {
          const message = String(error?.message ?? error?.shortMessage ?? "").toLowerCase();
          const isNonceConflict = message.includes("nonce too low")
            || message.includes("replacement transaction underpriced")
            || message.includes("already known")
            || message.includes("nonce has already been used");
          if (!isNonceConflict || attempt >= 4) {
            throw error;
          }
          const reportedStateNonce = Number(
            String(error?.message ?? error?.shortMessage ?? "").match(/state:\s*(\d+)/i)?.[1] ?? "NaN",
          );
          const refreshedNonce = Number.isFinite(reportedStateNonce)
            ? Math.max(await loadSuggestedNonce(), reportedStateNonce)
            : await loadSuggestedNonce();
          sharedState.nextNonce = refreshedNonce;
          nextAttemptNonce = refreshedNonce;
        }
      }
    } finally {
      releaseQueue();
    }
  };

  return new Proxy(signer as any, {
    get(target, prop, receiver) {
      if (prop === "address") {
        return address;
      }
      if (prop === "sendTransaction") {
        return sendTransaction;
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
}

export async function ensureRoleForAccount(params: {
  acm: any;
  roleName: string;
  account: string;
  granter?: any;
  ownerAddress?: string;
  autoGrant?: boolean;
  label?: string;
}) {
  const role = key(params.roleName);
  const roleAlreadyGrantedSelector = "0x598ba223";
  let hasRole = (await params.acm.hasRole(role, params.account)) as boolean;
  if (hasRole) {
    return true;
  }

  const ownerAddress = (params.ownerAddress ?? await params.acm.owner()) as string;
  const canGrant = Boolean(
    params.autoGrant
      && params.granter?.address
      && ownerAddress.toLowerCase() === String(params.granter.address).toLowerCase(),
  );
  if (!canGrant) {
    return false;
  }

  try {
    await (await params.acm.connect(params.granter).grantRole(role, params.account)).wait();
  } catch (error: any) {
    const revertData = String(error?.data ?? error?.info?.error?.data ?? "").toLowerCase();
    if (revertData !== roleAlreadyGrantedSelector) {
      hasRole = (await params.acm.hasRole(role, params.account)) as boolean;
      if (!hasRole) {
        throw error;
      }
    }
  }
  hasRole = (await params.acm.hasRole(role, params.account)) as boolean;
  if (hasRole) {
    console.log(
      `[Role] granted ${params.roleName} to ${params.label ?? params.account}`,
    );
  }
  return hasRole;
}

export async function updateAssetPriceWithRepair(params: {
  updater: any;
  acm: any;
  relayer: any;
  asset: MockAssetPackAsset;
  price: bigint;
  blockNumber: bigint | number;
}) {
  const invoke = () => params.updater
    .connect(params.relayer)
    .updateAssetPrice(params.asset.address, params.price, params.blockNumber);

  try {
    await params.updater
      .connect(params.relayer)
      .updateAssetPrice.staticCall(params.asset.address, params.price, params.blockNumber);
  } catch (error) {
    if (!envBool("LIVE_AUTO_REPAIR_PRICE_UPDATER_ASSET", true)) {
      throw error;
    }

    const ownerAddress = (await params.acm.owner()) as string;
    const hasSetParameter = await ensureRoleForAccount({
      acm: params.acm,
      roleName: "SET_PARAMETER",
      account: params.relayer.address,
      granter: params.relayer,
      ownerAddress,
      autoGrant: envBool("AUTO_GRANT_SET_PARAMETER", true),
      label: `relayer ${params.relayer.address}`,
    });
    if (!hasSetParameter) {
      throw new Error(
        `PriceUpdater asset repair required for ${params.asset.symbol}, but relayer ${params.relayer.address} lacks SET_PARAMETER`,
      );
    }

    await (
      await params.updater
        .connect(params.relayer)
        .configureAssetWithDecimals(
          params.asset.address,
          params.asset.sourceId,
          params.asset.decimals,
        )
    ).wait();
    console.log(
      `[PriceRepair] configured ${params.asset.symbol} in PriceUpdater sourceId=${params.asset.sourceId} decimals=${params.asset.decimals}`,
    );

    await params.updater
      .connect(params.relayer)
      .updateAssetPrice.staticCall(params.asset.address, params.price, params.blockNumber);
  }

  return await invoke();
}

// 纯读场景可以只给地址，不必掌握私钥，因此这里用 VoidSigner 包装调用者。
export function getReadCaller(label: string, addressEnv: string, fallbackSigner: any) {
  const address = envStrForWorker(addressEnv);
  if (address) {
    return {
      signer: new ethers.VoidSigner(ethers.getAddress(address), ethers.provider),
      source: addressEnv,
      label,
    };
  }

  return {
    signer: fallbackSigner,
    source: `fallback:${label}=default-signer`,
    label,
  };
}

export async function getRelayerSigner(fallbackSigner: any) {
  const pk = envStrForWorker("RELAYER_PRIVATE_KEY");
  if (pk) {
    const signer = await withNonceManagedSigner(new ethers.Wallet(pk, ethers.provider));
    return {
      signer,
      source: "RELAYER_PRIVATE_KEY",
    };
  }

  const signer = await withNonceManagedSigner(fallbackSigner);
  return {
    signer,
    source: "fallback:relayer=default-signer",
  };
}

export function createBestEffortValuationView(valuationViewAddr: string, preferredRunner?: any) {
  const abi = ["function getAssetPrice(address asset) view returns (uint256,uint256,bool)"];
  const providerView = new ethers.Contract(valuationViewAddr, abi, ethers.provider) as any;
  const runnerView = preferredRunner
    ? (new ethers.Contract(valuationViewAddr, abi, preferredRunner) as any)
    : null;

  return {
    target: valuationViewAddr,
    runner: preferredRunner ?? ethers.provider,
    async getAssetPrice(asset: string) {
      if (runnerView) {
        try {
          return await runnerView.getAssetPrice(asset);
        } catch {
          // Some live deployments are sensitive to the call sender; fall back to provider-only reads.
        }
      }
      return await providerView.getAssetPrice(asset);
    },
  } as any;
}

export async function requireCode(address: string, label: string) {
  if (!address || address === ethers.ZeroAddress) {
    throw new Error(`${label} is not configured`);
  }
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") {
    throw new Error(`${label} has no code at ${address}`);
  }
}

export function formatUnits(value: bigint, decimals: number) {
  return ethers.formatUnits(value, decimals);
}

export function shortAddr(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// 简单年化利息换算：principal * rateBps * term / year。
export function calcInterest(principal: bigint, rateBps: bigint, termSec: bigint) {
  const year = 365n * 24n * 60n * 60n;
  return (principal * rateBps * termSec) / (10_000n * year);
}

export function buildLendIntentHash(intent: {
  lenderSigner: string;
  asset: string;
  amount: bigint;
  minTermDays: number;
  maxTermDays: number;
  minRateBps: bigint;
  expireAt: bigint;
  salt: string;
}) {
  return ethers.TypedDataEncoder.hashStruct(
    "LendIntent",
    LEND_INTENT_TYPES as unknown as Record<string, TypedDataField[]>,
    intent,
  );
}

function extractRevertData(error: any): string {
  const data = error?.data ?? error?.error?.data ?? error?.info?.error?.data ?? error?.info?.data;
  if (typeof data === "string") return data;
  if (data && typeof data === "object" && typeof data.data === "string") return data.data;
  return "0x";
}

export function explainRevert(error: any, ifaces: Interface[]) {
  const revertData = extractRevertData(error);
  for (const iface of ifaces) {
    try {
      const parsed = iface.parseError(revertData);
      if (!parsed) {
        continue;
      }
      return `${parsed.name}(${parsed.args.map((arg: unknown) => String(arg)).join(", ")})`;
    } catch {
      // ignore and continue
    }
  }
  return decodeRevert(revertData);
}

export function parseLoanOrderId(receipt: any, orderEngine: any): bigint {
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = orderEngine.interface.parseLog({
        topics: log.topics as string[],
        data: log.data,
      });
      if (parsed?.name === "LoanOrderCreated") {
        return parsed.args.orderId as bigint;
      }
    } catch {
      // ignore unrelated logs
    }
  }

  throw new Error("LoanOrderCreated not found in finalizeMatch receipt");
}

// 统一观测一组 live 读指标，供 before / after-deposit / after-borrow / after-repay 横向对比。
export async function observeLiveState(params: {
  debtAsset: MockAssetPackAsset;
  collateralAsset: MockAssetPackAsset;
  borrower: any;
  lender: any;
  valuationView: any;
  viewCache: any;
  rewardView: any;
  healthView: any;
  positionView: any;
}) {
  const debtAssetPrice = (await params.valuationView.getAssetPrice(params.debtAsset.address)) as [bigint, bigint, boolean];
  const collateralPrice = (await params.valuationView.getAssetPrice(params.collateralAsset.address)) as [bigint, bigint, boolean];
  const [debtAssetStatus, debtAssetSystemValid] = (await params.viewCache.getSystemStatus(
    params.debtAsset.address,
  )) as [any, boolean];
  const [collateralStatus, collateralSystemValid] = (await params.viewCache.getSystemStatus(
    params.collateralAsset.address,
  )) as [any, boolean];

  const borrowerReward = (await params.rewardView
    .connect(params.borrower)
    .getUserRewardSummaryWithMeta(params.borrower.address)) as [bigint, bigint, number, bigint, bigint, boolean];
  const borrowerEarned = (await params.rewardView
    .connect(params.borrower)
    .getUserEasyEarnedWithMeta(params.borrower.address)) as [bigint, bigint, boolean];
  const lenderReward = (await params.rewardView
    .connect(params.lender)
    .getUserRewardSummaryWithMeta(params.lender.address)) as [bigint, bigint, number, bigint, bigint, boolean];
  const lenderEarned = (await params.rewardView
    .connect(params.lender)
    .getUserEasyEarnedWithMeta(params.lender.address)) as [bigint, bigint, boolean];
  const borrowerHealth = (await params.healthView
    .connect(params.borrower)
    .getUserHealthFactorWithMeta(params.borrower.address)) as [bigint, boolean, bigint];
  const collateralPosition = (await params.positionView
    .connect(params.borrower)
    .getUserPositionWithBlockMeta(params.borrower.address, params.collateralAsset.address)) as [
    bigint,
    bigint,
    boolean,
    bigint,
    bigint,
    bigint,
  ];
  const debtPosition = (await params.positionView
    .connect(params.borrower)
      .getUserPositionWithBlockMeta(params.borrower.address, params.debtAsset.address)) as [
    bigint,
    bigint,
    boolean,
    bigint,
    bigint,
    bigint,
  ];

  return {
    debtAssetPrice: debtAssetPrice[0],
    debtAssetPriceBlock: debtAssetPrice[1],
    debtAssetPriceValid: debtAssetPrice[2],
    collateralPrice: collateralPrice[0],
    collateralPriceBlock: collateralPrice[1],
    collateralPriceValid: collateralPrice[2],
    debtAssetSystemValid,
    debtAssetSystemUpdateBlock: BigInt(debtAssetStatus.updateBlock ?? debtAssetStatus[3] ?? 0),
    debtAssetTotalCollateral: BigInt(debtAssetStatus.totalCollateral ?? debtAssetStatus[0] ?? 0),
    debtAssetTotalDebt: BigInt(debtAssetStatus.totalDebt ?? debtAssetStatus[1] ?? 0),
    collateralSystemValid,
    collateralSystemUpdateBlock: BigInt(collateralStatus.updateBlock ?? collateralStatus[3] ?? 0),
    collateralTotalCollateral: BigInt(collateralStatus.totalCollateral ?? collateralStatus[0] ?? 0),
    collateralTotalDebt: BigInt(collateralStatus.totalDebt ?? collateralStatus[1] ?? 0),
    borrowerRewardBlock: borrowerReward[4],
    borrowerRewardValid: borrowerReward[5],
    borrowerPendingPenalty: borrowerReward[1],
    borrowerEasyEarned: borrowerEarned[0],
    borrowerEasyEarnedBlock: borrowerEarned[1],
    borrowerEasyEarnedValid: borrowerEarned[2],
    lenderRewardBlock: lenderReward[4],
    lenderRewardValid: lenderReward[5],
    lenderPendingPenalty: lenderReward[1],
    lenderEasyEarned: lenderEarned[0],
    lenderEasyEarnedBlock: lenderEarned[1],
    lenderEasyEarnedValid: lenderEarned[2],
    borrowerHealth: borrowerHealth[0],
    borrowerHealthValid: borrowerHealth[1],
    borrowerHealthBlock: borrowerHealth[2],
    collateralPositionCollateral: collateralPosition[0],
    collateralPositionDebt: collateralPosition[1],
    collateralPositionValid: collateralPosition[2],
    collateralPositionBlock: collateralPosition[3],
    collateralPositionAge: collateralPosition[4],
    debtPositionCollateral: debtPosition[0],
    debtPositionDebt: debtPosition[1],
    debtPositionValid: debtPosition[2],
    debtPositionBlock: debtPosition[3],
    debtPositionAge: debtPosition[4],
  } satisfies LiveObservation;
}

// 把观测结果按固定格式打印出来，便于不同脚本和不同阶段直接对比。
export function printObservation(label: string, observation: LiveObservation) {
  console.log(`\n[Observe] ${label}`);
  console.log(
    `  debtAsset.price valid=${observation.debtAssetPriceValid} price=${observation.debtAssetPrice.toString()} block=${observation.debtAssetPriceBlock.toString()}`,
  );
  console.log(
    `  collateral.price valid=${observation.collateralPriceValid} price=${observation.collateralPrice.toString()} block=${observation.collateralPriceBlock.toString()}`,
  );
  console.log(
    `  viewCache.debtAsset valid=${observation.debtAssetSystemValid} updateBlock=${observation.debtAssetSystemUpdateBlock.toString()} totalCollateral=${observation.debtAssetTotalCollateral.toString()} totalDebt=${observation.debtAssetTotalDebt.toString()}`,
  );
  console.log(
    `  viewCache.collateral valid=${observation.collateralSystemValid} updateBlock=${observation.collateralSystemUpdateBlock.toString()} totalCollateral=${observation.collateralTotalCollateral.toString()} totalDebt=${observation.collateralTotalDebt.toString()}`,
  );
  console.log(
    `  borrower.reward block=${observation.borrowerRewardBlock.toString()} valid=${observation.borrowerRewardValid} pendingPenalty=${observation.borrowerPendingPenalty.toString()} easyEarned=${observation.borrowerEasyEarned.toString()} easyBlock=${observation.borrowerEasyEarnedBlock.toString()} easyValid=${observation.borrowerEasyEarnedValid}`,
  );
  console.log(
    `  lender.reward block=${observation.lenderRewardBlock.toString()} valid=${observation.lenderRewardValid} pendingPenalty=${observation.lenderPendingPenalty.toString()} easyEarned=${observation.lenderEasyEarned.toString()} easyBlock=${observation.lenderEasyEarnedBlock.toString()} easyValid=${observation.lenderEasyEarnedValid}`,
  );
  console.log(
    `  borrower.health value=${observation.borrowerHealth.toString()} valid=${observation.borrowerHealthValid} block=${observation.borrowerHealthBlock.toString()}`,
  );
  console.log(
    `  borrower.collateralPosition collateral=${observation.collateralPositionCollateral.toString()} debt=${observation.collateralPositionDebt.toString()} valid=${observation.collateralPositionValid} updateBlock=${observation.collateralPositionBlock.toString()} age=${observation.collateralPositionAge.toString()}`,
  );
  console.log(
    `  borrower.debtPosition collateral=${observation.debtPositionCollateral.toString()} debt=${observation.debtPositionDebt.toString()} valid=${observation.debtPositionValid} updateBlock=${observation.debtPositionBlock.toString()} age=${observation.debtPositionAge.toString()}`,
  );
}