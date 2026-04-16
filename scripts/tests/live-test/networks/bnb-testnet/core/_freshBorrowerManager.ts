import fs from "fs";
import path from "path";

import { ethers, network } from "hardhat";

import { envBool, envStr } from "../../../../_addressResolver";
import { networkSlug, resolveBnbMinGasPriceWei, withNonceManagedSigner } from "./_mockLiveUtils";

type AutoSweepStatus = {
  installed: boolean;
  inProgress: Promise<void> | null;
  beforeExitTriggered: boolean;
  exitTriggered: boolean;
  originalExit?: typeof process.exit;
};

const autoSweepStatus: AutoSweepStatus = {
  installed: false,
  inProgress: null,
  beforeExitTriggered: false,
  exitTriggered: false,
};

export type Sponsor = {
  address: string;
  sendTransaction: (tx: { to: string; value: bigint }) => Promise<any>;
};

type NativeTopUpRecord = {
  targetAddress: string;
  sponsorAddress: string;
  label: string;
  amountWei: string;
  createdAt: string;
  txHash?: string;
  refundedWei?: string;
  refundedAt?: string;
  refundTxHash?: string;
};

type FreshBorrowerStateRecord = {
  index: number;
  address: string;
  label: string;
  mode: "managed" | "random";
  createdAt: string;
  refundAddress?: string;
  lastKnownBalanceWei?: string;
  sweptAt?: string;
  sweepTxHash?: string;
  sweptWei?: string;
  tokenSweptAt?: string;
  tokenSweepCount?: number;
  tokenSweptSummary?: string[];
};

type FreshBorrowerState = {
  version: 1;
  mnemonicFingerprint?: string;
  nextIndex: number;
  wallets: FreshBorrowerStateRecord[];
  nativeTopUps: NativeTopUpRecord[];
};

type FreshBorrowerAllocation = {
  wallet: any;
  mode: "managed" | "random";
  index?: number;
  finalBalance: bigint;
  refundAddress?: string;
};

function getStateFilePath() {
  const configured = envStr("LIVE_FRESH_BORROWER_STATE_FILE")?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return resolveDefaultFreshBorrowerStateFile();
}

function getConfiguredMnemonic() {
  return envStr("LIVE_FRESH_BORROWER_MNEMONIC")?.trim()
    || envStr("LIVE_FRESH_BORROWER_PHRASE")?.trim()
    || null;
}

function getStateMnemonicSidecarFilePath(stateFilePath: string) {
  return `${stateFilePath}.seed.json`;
}

function loadStateMnemonicFingerprint(stateFilePath: string) {
  if (!fs.existsSync(stateFilePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFilePath, "utf8")) as { mnemonicFingerprint?: string };
    return parsed.mnemonicFingerprint?.trim() || null;
  } catch {
    return null;
  }
}

function loadMnemonicFromSidecar(stateFilePath: string) {
  const sidecarPath = getStateMnemonicSidecarFilePath(stateFilePath);
  if (!fs.existsSync(sidecarPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, "utf8")) as { phrase?: string };
    return parsed.phrase?.trim() || null;
  } catch {
    return null;
  }
}

function loadDefaultFreshBorrowerMnemonicWithoutCreate() {
  const filePath = resolveDefaultFreshBorrowerMnemonicFile();
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { phrase?: string };
    return parsed.phrase?.trim() || null;
  } catch {
    return null;
  }
}

function ensureStateMnemonicSidecar(stateFilePath: string, mnemonic: string) {
  const fingerprint = getMnemonicFingerprint(mnemonic);
  const sidecarPath = getStateMnemonicSidecarFilePath(stateFilePath);
  const current = loadMnemonicFromSidecar(stateFilePath);
  if (current && getMnemonicFingerprint(current) === fingerprint) {
    return;
  }
  writeSecretJson(sidecarPath, {
    version: 1,
    network: network.name,
    createdAt: new Date().toISOString(),
    mnemonicFingerprint: fingerprint,
    phrase: mnemonic,
  });
}

function resolveMnemonicForStateFile(stateFilePath?: string | null) {
  const configured = getConfiguredMnemonic();
  if (!stateFilePath) {
    return configured || loadOrCreateDefaultFreshBorrowerMnemonic();
  }

  const expectedFingerprint = loadStateMnemonicFingerprint(stateFilePath);
  const configuredFingerprint = configured ? getMnemonicFingerprint(configured) : null;

  if (configured && (!expectedFingerprint || configuredFingerprint === expectedFingerprint)) {
    ensureStateMnemonicSidecar(stateFilePath, configured);
    return configured;
  }

  const sidecarMnemonic = loadMnemonicFromSidecar(stateFilePath);
  if (sidecarMnemonic) {
    const sidecarFingerprint = getMnemonicFingerprint(sidecarMnemonic);
    if (!expectedFingerprint || sidecarFingerprint === expectedFingerprint) {
      return sidecarMnemonic;
    }
  }

  const defaultMnemonic = loadDefaultFreshBorrowerMnemonicWithoutCreate() || loadOrCreateDefaultFreshBorrowerMnemonic();
  if (defaultMnemonic) {
    const defaultFingerprint = getMnemonicFingerprint(defaultMnemonic);
    if (!expectedFingerprint || defaultFingerprint === expectedFingerprint) {
      ensureStateMnemonicSidecar(stateFilePath, defaultMnemonic);
      return defaultMnemonic;
    }
  }

  return configured || defaultMnemonic;
}

function getMnemonic() {
  return resolveMnemonicForStateFile(getStateFilePath());
}

function shouldAutoManageFreshBorrowers() {
  return envBool("LIVE_FRESH_BORROWER_AUTO_MANAGE", true);
}

function resolveFreshBorrowerNetworkSlug() {
  return networkSlug(network.name);
}

function resolveWorkerSuffix() {
  const worker = envStr("LIVE_WORKER_INDEX")?.trim() ?? envStr("LIVE_WORKER_ID")?.trim();
  if (!worker) return null;
  return worker;
}

function resolveDefaultFreshBorrowerDir() {
  const base = path.resolve(process.cwd(), "scripts", "tests", "logs", "fresh-borrowers", resolveFreshBorrowerNetworkSlug());
  const workerSuffix = resolveWorkerSuffix();
  if (!workerSuffix) {
    return base;
  }
  return path.join(base, `worker-${workerSuffix}`);
}

function resolveDefaultFreshBorrowerStateFile() {
  if (!shouldAutoManageFreshBorrowers()) {
    return null;
  }
  return path.join(resolveDefaultFreshBorrowerDir(), "managed-state.json");
}

function resolveDefaultFreshBorrowerMnemonicFile() {
  if (!shouldAutoManageFreshBorrowers()) {
    return null;
  }
  return path.join(resolveDefaultFreshBorrowerDir(), "managed-seed.json");
}

function writeSecretJson(filePath: string, value: unknown) {
  ensureStateDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function loadOrCreateDefaultFreshBorrowerMnemonic() {
  if (!shouldAutoManageFreshBorrowers()) {
    return null;
  }

  const filePath = resolveDefaultFreshBorrowerMnemonicFile();
  if (!filePath) {
    return null;
  }

  if (fs.existsSync(filePath)) {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { phrase?: string };
    return parsed.phrase?.trim() || null;
  }

  const wallet = ethers.Wallet.createRandom();
  const phrase = wallet.mnemonic?.phrase?.trim();
  if (!phrase) {
    return null;
  }

  writeSecretJson(filePath, {
    version: 1,
    network: network.name,
    createdAt: new Date().toISOString(),
    phrase,
  });
  console.log(`[FreshBorrowerAutoManage] created default mnemonic file ${filePath}`);
  return phrase;
}

function getMnemonicFingerprint(mnemonic: string) {
  return ethers.id(mnemonic);
}

function buildDerivationPath(index: number) {
  return `m/44'/60'/0'/0/${index}`;
}

function ensureStateDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function loadState(filePath: string, mnemonic?: string | null): FreshBorrowerState {
  ensureStateDir(filePath);
  const mnemonicFingerprint = mnemonic ? getMnemonicFingerprint(mnemonic) : undefined;
  if (!fs.existsSync(filePath)) {
    return { version: 1, mnemonicFingerprint, nextIndex: 0, wallets: [], nativeTopUps: [] };
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as FreshBorrowerState;
  if (mnemonicFingerprint && parsed.wallets?.length && !parsed.mnemonicFingerprint) {
    throw new Error(
      `LIVE_FRESH_BORROWER_STATE_FILE is missing mnemonicFingerprint: ${filePath}. Use a new per-run state file instead of reusing an older file.`,
    );
  }
  if (mnemonicFingerprint && parsed.mnemonicFingerprint && parsed.mnemonicFingerprint !== mnemonicFingerprint) {
    throw new Error(
      `LIVE_FRESH_BORROWER_STATE_FILE belongs to a different mnemonic: ${filePath}. Generate a new per-run state file for each fresh mnemonic.`,
    );
  }
  return {
    version: 1,
    mnemonicFingerprint,
    nextIndex: parsed.nextIndex ?? 0,
    wallets: parsed.wallets ?? [],
    nativeTopUps: parsed.nativeTopUps ?? [],
  };
}

function saveState(filePath: string, state: FreshBorrowerState) {
  ensureStateDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

function upsertWalletRecord(filePath: string, next: FreshBorrowerStateRecord, mnemonic?: string | null) {
  const state = loadState(filePath, mnemonic);
  const index = state.wallets.findIndex((entry) => entry.address.toLowerCase() === next.address.toLowerCase());
  if (index >= 0) {
    state.wallets[index] = { ...state.wallets[index], ...next };
  } else {
    state.wallets.push(next);
  }
  saveState(filePath, state);
}

function appendNativeTopUpRecord(filePath: string, next: NativeTopUpRecord, mnemonic?: string | null) {
  const state = loadState(filePath, mnemonic);
  state.nativeTopUps.push(next);
  saveState(filePath, state);
}

function getOutstandingNativeTopUpWei(record: NativeTopUpRecord) {
  return BigInt(record.amountWei) - BigInt(record.refundedWei ?? "0");
}

async function waitForMinedTransaction(tx: { hash: string; wait: () => Promise<any> }) {
  try {
    const receipt = await tx.wait();
    return {
      hash: tx.hash,
      receipt,
    };
  } catch (error: any) {
    if (error?.code !== "TRANSACTION_REPLACED" || !error?.receipt || error?.cancelled !== true) {
      throw error;
    }
    return {
      hash: String(error?.replacement?.hash ?? error?.receipt?.hash ?? tx.hash),
      receipt: error.receipt,
    };
  }
}

async function waitForObservedBalance(params: {
  targetAddress: string;
  minBalanceWei: bigint;
  initialBalanceWei?: bigint;
  attempts?: number;
  delayMs?: number;
}) {
  let balance = params.initialBalanceWei ?? await ethers.provider.getBalance(params.targetAddress);
  const attempts = Math.max(1, params.attempts ?? 6);
  const delayMs = Math.max(0, params.delayMs ?? 1000);

  for (let attempt = 0; attempt < attempts && balance < params.minBalanceWei; attempt += 1) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    balance = await ethers.provider.getBalance(params.targetAddress);
  }

  return balance;
}

function isInsufficientNativeForSweep(error: any) {
  const message = String(error?.message ?? error?.shortMessage ?? "").toLowerCase();
  return message.includes("insufficient funds for gas * price + value")
    || message.includes("overshot")
    || message.includes("insufficient funds");
}

function listOutstandingNativeTopUps(state: FreshBorrowerState, targetAddress: string) {
  const normalizedTarget = targetAddress.toLowerCase();
  return state.nativeTopUps.filter((record) => {
    if (record.targetAddress.toLowerCase() !== normalizedTarget) {
      return false;
    }
    return getOutstandingNativeTopUpWei(record) > 0n;
  });
}

async function runAutoSweep(trigger: string) {
  if (!envBool("LIVE_FRESH_BORROWER_AUTO_SWEEP", true)) {
    return;
  }
  if (autoSweepStatus.inProgress) {
    await autoSweepStatus.inProgress;
    return;
  }

  autoSweepStatus.inProgress = (async () => {
    try {
      await sweepManagedFreshBorrowers();
    } catch (error) {
      console.error(`[FreshBorrowerAutoSweep] ${trigger} failed`);
      console.error(error);
    }
  })();

  try {
    await autoSweepStatus.inProgress;
  } finally {
    autoSweepStatus.inProgress = null;
  }
}

function installAutoSweepHooks() {
  if (autoSweepStatus.installed || !shouldAutoManageFreshBorrowers()) {
    return;
  }

  autoSweepStatus.installed = true;
  autoSweepStatus.originalExit = process.exit.bind(process);

  process.once("beforeExit", () => {
    if (autoSweepStatus.beforeExitTriggered) {
      return;
    }
    autoSweepStatus.beforeExitTriggered = true;
    void runAutoSweep("beforeExit");
  });

  process.exit = ((code?: number) => {
    if (autoSweepStatus.exitTriggered) {
      return autoSweepStatus.originalExit?.(code as number) as never;
    }
    autoSweepStatus.exitTriggered = true;
    if (typeof code === "number") {
      process.exitCode = code;
    }
    void runAutoSweep("process.exit").finally(() => {
      autoSweepStatus.originalExit?.(code as number);
    });
    return undefined as never;
  }) as typeof process.exit;
}

export async function ensureRecoverableNativeTopUp(params: {
  label: string;
  target: { address: string };
  sponsors: Sponsor[];
  desiredBalanceWei: bigint;
  reserveWei: bigint;
  failOnShortfall?: boolean;
}) {
  const beforeBalance = await ethers.provider.getBalance(params.target.address);
  if (beforeBalance >= params.desiredBalanceWei) {
    return {
      beforeBalance,
      finalBalance: beforeBalance,
      refundAddress: undefined,
    };
  }

  const stateFile = getStateFilePath();
  const mnemonic = getMnemonic();
  let remainingTopUp = params.desiredBalanceWei - beforeBalance;
  let totalSentWei = 0n;
  const seenSponsors = new Set<string>();
  let refundAddress: string | undefined;

  for (const sponsor of params.sponsors) {
    const signerKey = sponsor.address.toLowerCase();
    if (signerKey === params.target.address.toLowerCase() || seenSponsors.has(signerKey)) {
      continue;
    }
    seenSponsors.add(signerKey);
    if (remainingTopUp === 0n) {
      break;
    }

    const sponsorBalance = await ethers.provider.getBalance(sponsor.address);
    const affordableTopUp = sponsorBalance > params.reserveWei ? sponsorBalance - params.reserveWei : 0n;
    const topUpAmount = remainingTopUp > affordableTopUp ? affordableTopUp : remainingTopUp;
    if (topUpAmount === 0n) {
      continue;
    }

    let sent;
    try {
      sent = await sponsor.sendTransaction({ to: params.target.address, value: topUpAmount });
    } catch (error: any) {
      const message = String(error?.message ?? error?.shortMessage ?? "").toLowerCase();
      const code = String(error?.code ?? "").toUpperCase();
      if (code === "UNSUPPORTED_OPERATION" || message.includes("missing provider") || message.includes("unsupported operation")) {
        console.log(`[FreshBorrowerTopUp] skip unusable sponsor=${sponsor.address} label=${params.label}`);
        continue;
      }
      throw error;
    }
    const mined = await waitForMinedTransaction(sent);
    if (stateFile) {
      appendNativeTopUpRecord(stateFile, {
        targetAddress: params.target.address,
        sponsorAddress: sponsor.address,
        label: params.label,
        amountWei: topUpAmount.toString(),
        createdAt: new Date().toISOString(),
        txHash: mined.hash,
      }, mnemonic);
    }
    remainingTopUp -= topUpAmount;
    totalSentWei += topUpAmount;
    if (!refundAddress) {
      refundAddress = sponsor.address;
    }
  }

  let finalBalance = await ethers.provider.getBalance(params.target.address);
  if (totalSentWei > 0n) {
    finalBalance = await waitForObservedBalance({
      targetAddress: params.target.address,
      minBalanceWei: params.desiredBalanceWei,
      initialBalanceWei: finalBalance,
    });
  }
  if (finalBalance < params.desiredBalanceWei && params.failOnShortfall !== false) {
    throw new Error(
      `${params.label}: native top-up insufficient: have=${ethers.formatEther(finalBalance)} ETH desired=${ethers.formatEther(params.desiredBalanceWei)} ETH reserve=${ethers.formatEther(params.reserveWei)} ETH`,
    );
  }

  return {
    beforeBalance,
    finalBalance,
    refundAddress,
  };
}

type SweepTokenDescriptor = {
  address: string;
  symbol: string;
};

type RoleSweepWallet = {
  label: string;
  envName: string;
  wallet: any;
};

const ERC20_SWEEP_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to,uint256 amount) returns (bool)",
  "function symbol() view returns (string)",
];

function uniqueAddresses(values: string[]) {
  return [...new Set(values.map((value) => value.toLowerCase()))];
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

async function resolveRoleSweepWallets(params: {
  excludedAddresses: string[];
}) {
  if (!envBool("LIVE_FRESH_BORROWER_SWEEP_ROLE_ACTORS", true)) {
    return [] as RoleSweepWallet[];
  }

  const explicitEnvNames = envStr("LIVE_FRESH_BORROWER_SWEEP_ROLE_PRIVATE_KEY_ENVS")
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const envNames = explicitEnvNames && explicitEnvNames.length > 0
    ? explicitEnvNames
    : ["BORROWER_PRIVATE_KEY", "LENDER_PRIVATE_KEY", "BLOCKS_ONLY_KEEPER_PRIVATE_KEY", "VIEWER_PRIVATE_KEY", "UPDATER_PRIVATE_KEY"];

  const excluded = new Set(params.excludedAddresses.map((address) => address.toLowerCase()));
  const seen = new Set<string>();
  const wallets: RoleSweepWallet[] = [];

  for (const envName of envNames) {
    const privateKey = envStrForWorker(envName)?.trim();
    if (!privateKey) {
      continue;
    }

    try {
      const signer = await withNonceManagedSigner(new ethers.Wallet(privateKey, ethers.provider));
      const normalized = signer.address.toLowerCase();
      if (excluded.has(normalized) || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      wallets.push({
        label: envName.replace(/_PRIVATE_KEY$/, "").toLowerCase(),
        envName,
        wallet: signer,
      });
    } catch (error) {
      console.log(`[FreshBorrowerSweep] skip invalid role signer env=${envName}: ${String(error)}`);
    }
  }

  return wallets;
}

function resolveDefaultMockAssetPackFile() {
  const configured = envStr("MOCK_ASSET_PACK_OUTPUT")?.trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
  }

  const slug =
    network.name === "arbitrumSepolia"
      ? "arbitrum-sepolia"
      : network.name === "bnbTestnet"
        ? "bnb-testnet"
        : network.name;
  return path.resolve(process.cwd(), "deployments", `mock-assets.${slug}.json`);
}

function loadSweepTokenDescriptors(): SweepTokenDescriptor[] {
  const descriptors = new Map<string, SweepTokenDescriptor>();
  const explicitAddresses = envStr("LIVE_FRESH_BORROWER_SWEEP_TOKEN_ADDRESSES")
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean) ?? [];

  for (const address of uniqueAddresses(explicitAddresses)) {
    descriptors.set(address, { address: ethers.getAddress(address), symbol: address.slice(0, 10) });
  }

  const packFile = resolveDefaultMockAssetPackFile();
  if (fs.existsSync(packFile)) {
    const parsed = JSON.parse(fs.readFileSync(packFile, "utf8")) as {
      assets?: Array<{ address?: string; symbol?: string }>;
    };
    for (const asset of parsed.assets ?? []) {
      if (!asset.address) {
        continue;
      }
      const normalized = asset.address.toLowerCase();
      if (!descriptors.has(normalized)) {
        descriptors.set(normalized, {
          address: ethers.getAddress(asset.address),
          symbol: asset.symbol?.trim() || asset.address.slice(0, 10),
        });
      }
    }
  }

  return [...descriptors.values()];
}

async function sweepMockTokensForWallet(params: {
  wallet: any;
  refundAddress: string;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}) {
  const summaries: string[] = [];
  const tokens = loadSweepTokenDescriptors();

  for (const tokenInfo of tokens) {
    const token = (await ethers.getContractAt(ERC20_SWEEP_ABI, tokenInfo.address, params.wallet)) as any;
    const balance = (await token.balanceOf(params.wallet.address)) as bigint;
    if (balance === 0n) {
      continue;
    }

    const currentNativeBalance = await ethers.provider.getBalance(params.wallet.address);
    let estimateGas = 65_000n;
    try {
      estimateGas = BigInt(await token.transfer.estimateGas(params.refundAddress, balance));
    } catch {
      // Fall back to a conservative transfer gas budget for mock ERC20s.
    }
    const gasLimit = (estimateGas * 12_000n) / 10_000n;
    const txCost = gasLimit * params.maxFeePerGas;
    if (currentNativeBalance <= txCost) {
      summaries.push(`${tokenInfo.symbol}:skip-native-gas`);
      continue;
    }

    const tx = await token.transfer(params.refundAddress, balance, {
      gasLimit,
      maxFeePerGas: params.maxFeePerGas,
      maxPriorityFeePerGas: params.maxPriorityFeePerGas,
    });
    await tx.wait();
    summaries.push(`${tokenInfo.symbol}:${balance.toString()}`);
  }

  return summaries;
}

async function estimateFreshBorrowerNativeAmount(overrideNativeAmountEth?: string) {
  const configured = overrideNativeAmountEth?.trim() || envStr("LIVE_FRESH_BORROWER_NATIVE_ETH")?.trim();
  if (configured) {
    return ethers.parseEther(configured);
  }
  const txBudget = Math.max(1, Number(envStr("LIVE_FRESH_BORROWER_TX_BUDGET") ?? "8"));
  const gasPerTx = BigInt(Math.max(21_000, Number(envStr("LIVE_FRESH_BORROWER_GAS_PER_TX") ?? "100000")));
  const feeData = await ethers.provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? resolveBnbMinGasPriceWei();
  const estimate = gasPrice * gasPerTx * BigInt(txBudget) * 2n;
  const floor = ethers.parseEther("0.00005");
  return estimate > floor ? estimate : floor;
}

function allocateManagedWallet(label: string) {
  const stateFile = getStateFilePath();
  const mnemonic = resolveMnemonicForStateFile(stateFile);
  if (!mnemonic || !stateFile) {
    return null;
  }

  installAutoSweepHooks();

  const state = loadState(stateFile, mnemonic);
  const index = state.nextIndex;
  state.nextIndex += 1;
  saveState(stateFile, state);

  const wallet = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, buildDerivationPath(index)).connect(ethers.provider);
  upsertWalletRecord(stateFile, {
    index,
    address: wallet.address,
    label,
    mode: "managed",
    createdAt: new Date().toISOString(),
  }, mnemonic);
  return { wallet, index, stateFile };
}

export async function assignFreshBorrowerWithRecovery(params: {
  label: string;
  noticeLabel?: string;
  sponsors: Sponsor[];
  nativeAmountWei?: bigint;
  nativeAmountEth?: string;
  sponsorReserveEth?: string;
}) : Promise<FreshBorrowerAllocation> {
  const managed = allocateManagedWallet(params.label);
  const wallet = managed?.wallet ?? ethers.Wallet.createRandom().connect(ethers.provider);
  const mode = managed ? "managed" : "random";
  const desiredNativeAmount = params.nativeAmountWei ?? await estimateFreshBorrowerNativeAmount(params.nativeAmountEth);
  const sponsorReserve = ethers.parseEther(params.sponsorReserveEth ?? envStr("LIVE_FRESH_BORROWER_RELAYER_RESERVE_ETH") ?? "0.0002");

  const { finalBalance, refundAddress } = await ensureRecoverableNativeTopUp({
    label: `${params.label}: fresh borrower native reserve`,
    target: wallet,
    sponsors: params.sponsors,
    desiredBalanceWei: desiredNativeAmount,
    reserveWei: sponsorReserve,
    failOnShortfall: false,
  });

  if (managed?.stateFile) {
    const stateMnemonic = resolveMnemonicForStateFile(managed.stateFile);
    upsertWalletRecord(managed.stateFile, {
      index: managed.index,
      address: wallet.address,
      label: params.label,
      mode,
      createdAt: new Date().toISOString(),
      refundAddress,
      lastKnownBalanceWei: finalBalance.toString(),
    }, stateMnemonic);
  }

  if (finalBalance < desiredNativeAmount) {
    console.log(
      `  [Notice] fresh borrower native top-up capped by sponsor balances: desired=${ethers.formatEther(desiredNativeAmount)} ETH actual=${ethers.formatEther(finalBalance)} ETH reserveLeft=${ethers.formatEther(sponsorReserve)} ETH`,
    );
  }
  console.log(
    `  [Notice] ${params.noticeLabel ?? "using fresh borrower"} ${wallet.address} (native=${ethers.formatEther(finalBalance)} ETH mode=${mode})`,
  );

  return {
    wallet,
    mode,
    index: managed?.index,
    finalBalance,
    refundAddress,
  };
}

export function getManagedFreshBorrowerSponsors(excludeAddresses: string[] = []): Sponsor[] {
  const stateFile = getStateFilePath();
  const mnemonic = resolveMnemonicForStateFile(stateFile);
  if (!mnemonic || !stateFile || !fs.existsSync(stateFile)) {
    return [];
  }

  const excluded = new Set(excludeAddresses.map((address) => address.toLowerCase()));
  const state = loadState(stateFile, mnemonic);
  return state.wallets
    .filter((record) => record.mode === "managed" && typeof record.index === "number" && !record.sweptAt)
    .map((record) => ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, buildDerivationPath(record.index)).connect(ethers.provider))
    .filter((wallet) => !excluded.has(wallet.address.toLowerCase()))
    .map((wallet) => ({
      address: wallet.address,
      sendTransaction: wallet.sendTransaction.bind(wallet),
    }));
}

export async function sweepManagedFreshBorrowers() {
  const stateFile = getStateFilePath();
  const mnemonic = resolveMnemonicForStateFile(stateFile);
  if (!stateFile) {
    console.log("[FreshBorrowerSweep] skipped: fresh borrower auto-manage is disabled");
    return { swept: 0, skipped: 0 };
  }
  if (!mnemonic) {
    console.log(`[FreshBorrowerSweep] skipped: mnemonic is not configured for stateFile=${stateFile}`);
    return { swept: 0, skipped: 0 };
  }
  if (!fs.existsSync(stateFile)) {
    console.log(`[FreshBorrowerSweep] skipped: no managed fresh borrower state file at ${stateFile}; no managed borrower was allocated in this run`);
    return { swept: 0, skipped: 0 };
  }

  const state = loadState(stateFile, mnemonic);
  const [rawRelayer] = await ethers.getSigners();
  const relayer = await withNonceManagedSigner(rawRelayer);
  const enableTokenSweep = envBool("LIVE_FRESH_BORROWER_SWEEP_ERC20", true);
  const feeData = await ethers.provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? resolveBnbMinGasPriceWei();
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? resolveBnbMinGasPriceWei();
  const gasLimit = 21_000n;
  const txCost = maxFeePerGas * gasLimit;
  const sweepAssistEnabled = envBool("LIVE_FRESH_BORROWER_SWEEP_GAS_ASSIST", true);
  const sweepAssistReserveWei = ethers.parseEther(
    envStr("LIVE_FRESH_BORROWER_SWEEP_ASSIST_RESERVE_ETH")
      ?? envStr("LIVE_RELAYER_NATIVE_SWEEP_RESERVE_ETH")
      ?? envStr("LIVE_RELAYER_NATIVE_SPONSOR_RESERVE_ETH")
      ?? envStr("LIVE_FRESH_BORROWER_RELAYER_RESERVE_ETH")
      ?? "0.00005",
  );

  let swept = 0;
  let skipped = 0;
  let tokenSwept = 0;
  let roleWalletsScanned = 0;
  let roleWalletsWithTokenSweep = 0;

  const resolveSponsorSignerForSweep = async (sponsorAddress: string) => {
    const normalized = sponsorAddress.toLowerCase();
    if (normalized === relayer.address.toLowerCase()) {
      return relayer;
    }

    const walletRecord = state.wallets.find(
      (record) => record.mode === "managed" && typeof record.index === "number" && record.address.toLowerCase() === normalized,
    );
    if (walletRecord) {
      return withNonceManagedSigner(
        ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, buildDerivationPath(walletRecord.index)).connect(ethers.provider),
      );
    }

    return null;
  };

  const maybeAssistSweepGas = async (params: {
    target: any;
    targetAddress: string;
    requiredBalanceWei: bigint;
    preferredSponsorAddresses: string[];
  }) => {
    if (!sweepAssistEnabled) {
      return false;
    }
    const current = await ethers.provider.getBalance(params.targetAddress);
    if (current >= params.requiredBalanceWei) {
      return true;
    }

    let needed = params.requiredBalanceWei - current;
    for (const sponsorAddress of uniqueAddresses(params.preferredSponsorAddresses)) {
      if (needed === 0n) {
        break;
      }
      const sponsor = await resolveSponsorSignerForSweep(sponsorAddress);
      if (!sponsor || sponsor.address.toLowerCase() === params.targetAddress.toLowerCase()) {
        continue;
      }

      const sponsorBalance = await ethers.provider.getBalance(sponsor.address);
      const affordable = sponsorBalance > sweepAssistReserveWei ? sponsorBalance - sweepAssistReserveWei : 0n;
      const assistAmount = needed > affordable ? affordable : needed;
      if (assistAmount === 0n) {
        continue;
      }

      try {
        await (await sponsor.sendTransaction({ to: params.targetAddress, value: assistAmount })).wait();
      } catch {
        continue;
      }

      const updated = await ethers.provider.getBalance(params.targetAddress);
      if (updated >= params.requiredBalanceWei) {
        return true;
      }
      needed = params.requiredBalanceWei - updated;
    }

    const finalBalance = await ethers.provider.getBalance(params.targetAddress);
    return finalBalance >= params.requiredBalanceWei;
  };

  const settleRecordedNativeTopUps = async (params: {
    target: any;
    targetAddress: string;
    retainWei: bigint;
  }) => {
    const outstanding = listOutstandingNativeTopUps(state, params.targetAddress);
    if (outstanding.length === 0) {
      return 0;
    }

    const grouped = new Map<string, NativeTopUpRecord[]>();
    for (const record of outstanding) {
      const key = record.sponsorAddress.toLowerCase();
      const bucket = grouped.get(key);
      if (bucket) {
        bucket.push(record);
      } else {
        grouped.set(key, [record]);
      }
    }

    let refundedTxCount = 0;
    for (const [sponsorKey, records] of grouped.entries()) {
      let balance = await ethers.provider.getBalance(params.target.address);
      if (balance <= params.retainWei + txCost) {
        const assisted = await maybeAssistSweepGas({
          target: params.target,
          targetAddress: params.targetAddress,
          requiredBalanceWei: params.retainWei + txCost,
          preferredSponsorAddresses: [sponsorKey, relayer.address],
        });
        if (!assisted) {
          break;
        }
        balance = await ethers.provider.getBalance(params.target.address);
      }

      const transferable = balance - params.retainWei - txCost;
      const outstandingAmount = records.reduce((sum, record) => sum + getOutstandingNativeTopUpWei(record), 0n);
      const refundValue = transferable > outstandingAmount ? outstandingAmount : transferable;
      if (refundValue === 0n) {
        continue;
      }

      let mined;
      try {
        const tx = await params.target.sendTransaction({
          to: ethers.getAddress(sponsorKey),
          value: refundValue,
          gasLimit,
          maxFeePerGas,
          maxPriorityFeePerGas,
        });
        mined = await waitForMinedTransaction(tx);
      } catch (error: any) {
        if (isInsufficientNativeForSweep(error)) {
          continue;
        }
        throw error;
      }

      let remainingAllocation = refundValue;
      const refundedAt = new Date().toISOString();
      for (const record of records) {
        if (remainingAllocation === 0n) {
          break;
        }
        const outstandingWei = getOutstandingNativeTopUpWei(record);
        const delta = remainingAllocation > outstandingWei ? outstandingWei : remainingAllocation;
        const nextRefundedWei = BigInt(record.refundedWei ?? "0") + delta;
        record.refundedWei = nextRefundedWei.toString();
        record.refundTxHash = mined.hash;
        if (nextRefundedWei >= BigInt(record.amountWei)) {
          record.refundedAt = refundedAt;
        }
        remainingAllocation -= delta;
      }
      refundedTxCount += 1;
    }

    return refundedTxCount;
  };

  for (const record of state.wallets) {
    if (record.mode !== "managed" || record.sweptAt) {
      skipped += 1;
      continue;
    }
    if (!record.refundAddress) {
      const outstanding = listOutstandingNativeTopUps(state, record.address);
      if (outstanding.length > 0) {
        record.refundAddress = outstanding[0].sponsorAddress;
      } else {
        record.refundAddress = relayer.address;
      }
    }

    const wallet = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, buildDerivationPath(record.index)).connect(ethers.provider);
    if (enableTokenSweep && record.refundAddress) {
      const tokenSummaries = await sweepMockTokensForWallet({
        wallet,
        refundAddress: record.refundAddress,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
      if (tokenSummaries.length > 0) {
        record.tokenSweptAt = new Date().toISOString();
        record.tokenSweepCount = tokenSummaries.filter((entry) => !entry.includes(":skip-")).length;
        record.tokenSweptSummary = tokenSummaries;
        tokenSwept += record.tokenSweepCount;
      }
    }

    const reimbursedCount = await settleRecordedNativeTopUps({
      target: wallet,
      targetAddress: wallet.address,
      retainWei: 0n,
    });
    if (reimbursedCount > 0) {
      record.lastKnownBalanceWei = (await ethers.provider.getBalance(wallet.address)).toString();
      if (listOutstandingNativeTopUps(state, wallet.address).length === 0) {
        record.sweptAt = new Date().toISOString();
      }
      swept += reimbursedCount;
      continue;
    }

    let balance = await ethers.provider.getBalance(wallet.address);
    if (balance <= txCost || !record.refundAddress) {
      const assisted = await maybeAssistSweepGas({
        target: wallet,
        targetAddress: wallet.address,
        requiredBalanceWei: txCost,
        preferredSponsorAddresses: [record.refundAddress ?? relayer.address, relayer.address],
      });
      if (assisted) {
        balance = await ethers.provider.getBalance(wallet.address);
      }
    }

    if (balance <= txCost || !record.refundAddress) {
      record.lastKnownBalanceWei = balance.toString();
      skipped += 1;
      continue;
    }

    const value = balance - txCost;
    let mined;
    try {
      const tx = await wallet.sendTransaction({
        to: record.refundAddress,
        value,
        gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
      mined = await waitForMinedTransaction(tx);
    } catch (error: any) {
      if (isInsufficientNativeForSweep(error)) {
        record.lastKnownBalanceWei = balance.toString();
        skipped += 1;
        continue;
      }
      throw error;
    }
    record.sweptAt = new Date().toISOString();
    record.sweepTxHash = mined.hash;
    record.sweptWei = value.toString();
    record.lastKnownBalanceWei = (await ethers.provider.getBalance(wallet.address)).toString();
    swept += 1;
  }

  const roleSweepWallets = await resolveRoleSweepWallets({
    excludedAddresses: [relayer.address],
  });
  roleWalletsScanned = roleSweepWallets.length;
  if (enableTokenSweep && roleSweepWallets.length > 0) {
    for (const roleEntry of roleSweepWallets) {
      const tokenSummaries = await sweepMockTokensForWallet({
        wallet: roleEntry.wallet,
        refundAddress: relayer.address,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
      const moved = tokenSummaries.filter((entry) => !entry.includes(":skip-")).length;
      if (moved > 0) {
        roleWalletsWithTokenSweep += 1;
        tokenSwept += moved;
        console.log(
          `[FreshBorrowerSweep] role=${roleEntry.label} env=${roleEntry.envName} tokenMoves=${moved} details=${tokenSummaries.join(",")}`,
        );
      }
    }
  }

  const relayerRetainWei = ethers.parseEther(
    envStr("LIVE_RELAYER_NATIVE_SWEEP_RESERVE_ETH")
      ?? envStr("LIVE_RELAYER_NATIVE_SPONSOR_RESERVE_ETH")
      ?? envStr("LIVE_FRESH_BORROWER_RELAYER_RESERVE_ETH")
      ?? "0.00005",
  );
  swept += await settleRecordedNativeTopUps({
    target: relayer,
    targetAddress: relayer.address,
    retainWei: relayerRetainWei,
  });

  saveState(stateFile, state);
  if (enableTokenSweep) {
    console.log(
      `[FreshBorrowerSweep] swept=${swept} tokenSwept=${tokenSwept} skipped=${skipped} roleWalletsScanned=${roleWalletsScanned} roleWalletsWithTokenSweep=${roleWalletsWithTokenSweep} stateFile=${stateFile}`,
    );
    return {
      swept,
      tokenSwept,
      skipped,
      roleWalletsScanned,
      roleWalletsWithTokenSweep,
    };
  }

  console.log(`[FreshBorrowerSweep] swept=${swept} skipped=${skipped} stateFile=${stateFile}`);
  return { swept, skipped };
}