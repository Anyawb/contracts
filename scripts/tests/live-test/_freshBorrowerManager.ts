import fs from "fs";
import path from "path";

import { ethers, network } from "hardhat";

import { envBool, envStr } from "../_addressResolver";
import { withNonceManagedSigner } from "./_mockLiveUtils";

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
  return configured ? path.resolve(configured) : null;
}

function getMnemonic() {
  return envStr("LIVE_FRESH_BORROWER_MNEMONIC")?.trim() || envStr("LIVE_FRESH_BORROWER_PHRASE")?.trim() || null;
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

function listOutstandingNativeTopUps(state: FreshBorrowerState, targetAddress: string) {
  const normalizedTarget = targetAddress.toLowerCase();
  return state.nativeTopUps.filter((record) => {
    if (record.targetAddress.toLowerCase() !== normalizedTarget) {
      return false;
    }
    return getOutstandingNativeTopUpWei(record) > 0n;
  });
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

    await (await sponsor.sendTransaction({ to: params.target.address, value: topUpAmount })).wait();
    if (stateFile) {
      appendNativeTopUpRecord(stateFile, {
        targetAddress: params.target.address,
        sponsorAddress: sponsor.address,
        label: params.label,
        amountWei: topUpAmount.toString(),
        createdAt: new Date().toISOString(),
      }, mnemonic);
    }
    remainingTopUp -= topUpAmount;
    if (!refundAddress) {
      refundAddress = sponsor.address;
    }
  }

  const finalBalance = await ethers.provider.getBalance(params.target.address);
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

const ERC20_SWEEP_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to,uint256 amount) returns (bool)",
  "function symbol() view returns (string)",
];

function uniqueAddresses(values: string[]) {
  return [...new Set(values.map((value) => value.toLowerCase()))];
}

function resolveDefaultMockAssetPackFile() {
  const configured = envStr("MOCK_ASSET_PACK_OUTPUT")?.trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
  }

  const slug = network.name === "arbitrumSepolia" ? "arbitrum-sepolia" : network.name;
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
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 50_000_000n;
  const estimate = gasPrice * gasPerTx * BigInt(txBudget) * 2n;
  const floor = ethers.parseEther("0.00005");
  return estimate > floor ? estimate : floor;
}

function allocateManagedWallet(label: string) {
  const mnemonic = getMnemonic();
  const stateFile = getStateFilePath();
  if (!mnemonic || !stateFile) {
    return null;
  }

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
    upsertWalletRecord(managed.stateFile, {
      index: managed.index,
      address: wallet.address,
      label: params.label,
      mode,
      createdAt: new Date().toISOString(),
      refundAddress,
      lastKnownBalanceWei: finalBalance.toString(),
    }, getMnemonic());
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

export async function sweepManagedFreshBorrowers() {
  const mnemonic = getMnemonic();
  const stateFile = getStateFilePath();
  if (!mnemonic || !stateFile || !fs.existsSync(stateFile)) {
    console.log("[FreshBorrowerSweep] skipped: mnemonic or state file is not configured");
    return { swept: 0, skipped: 0 };
  }

  const state = loadState(stateFile, mnemonic);
  const [rawRelayer] = await ethers.getSigners();
  const relayer = await withNonceManagedSigner(rawRelayer);
  const enableTokenSweep = envBool("LIVE_FRESH_BORROWER_SWEEP_ERC20", false);
  const feeData = await ethers.provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? 50_000_000n;
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? 10_000_000n;
  const gasLimit = 21_000n;
  const txCost = maxFeePerGas * gasLimit;

  let swept = 0;
  let skipped = 0;
  let tokenSwept = 0;

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
      const balance = await ethers.provider.getBalance(params.target.address);
      if (balance <= params.retainWei + txCost) {
        break;
      }

      const transferable = balance - params.retainWei - txCost;
      const outstandingAmount = records.reduce((sum, record) => sum + getOutstandingNativeTopUpWei(record), 0n);
      const refundValue = transferable > outstandingAmount ? outstandingAmount : transferable;
      if (refundValue === 0n) {
        continue;
      }

      const tx = await params.target.sendTransaction({
        to: ethers.getAddress(sponsorKey),
        value: refundValue,
        gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
      await tx.wait();

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
        record.refundTxHash = tx.hash;
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
    const wallet = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, buildDerivationPath(record.index)).connect(ethers.provider);
    if (enableTokenSweep) {
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

    const balance = await ethers.provider.getBalance(wallet.address);
    if (balance <= txCost || !record.refundAddress) {
      record.lastKnownBalanceWei = balance.toString();
      skipped += 1;
      continue;
    }

    const value = balance - txCost;
    const tx = await wallet.sendTransaction({
      to: record.refundAddress,
      value,
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    await tx.wait();
    record.sweptAt = new Date().toISOString();
    record.sweepTxHash = tx.hash;
    record.sweptWei = value.toString();
    record.lastKnownBalanceWei = (await ethers.provider.getBalance(wallet.address)).toString();
    swept += 1;
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
    console.log(`[FreshBorrowerSweep] swept=${swept} tokenSwept=${tokenSwept} skipped=${skipped} stateFile=${stateFile}`);
    return { swept, tokenSwept, skipped };
  }

  console.log(`[FreshBorrowerSweep] swept=${swept} skipped=${skipped} stateFile=${stateFile}`);
  return { swept, skipped };
}