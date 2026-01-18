import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";

export function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

export function uniqAddrs(addrs: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of addrs) {
    if (!a || a === ethers.ZeroAddress) continue;
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

export function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function fmtAmount(x: bigint, decimals: number) {
  return ethers.formatUnits(x, decimals);
}

export async function getErc20(tokenAddr: string) {
  return await ethers.getContractAt(
    [
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
      "function totalSupply() view returns (uint256)",
      "function balanceOf(address) view returns (uint256)",
      "function transfer(address to, uint256 amount) returns (bool)",
      "function transferFrom(address from, address to, uint256 amount) returns (bool)",
      "function approve(address spender, uint256 amount) returns (bool)",
    ],
    tokenAddr
  );
}

export type BalanceSnapshot = {
  token: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  balances: Map<string, bigint>;
  sumTracked: bigint;
};

export async function snapshotBalances(tokenAddr: string, addresses: string[]): Promise<BalanceSnapshot> {
  const erc20 = await getErc20(tokenAddr);
  const [symbol, decimals] = await Promise.all([erc20.symbol().catch(() => "TOKEN"), erc20.decimals().catch(() => 18)]);
  const addrs = uniqAddrs(addresses);
  const [totalSupply, bals] = await Promise.all([
    (erc20.totalSupply() as Promise<bigint>),
    Promise.all(addrs.map(async (a) => [a, (await erc20.balanceOf(a)) as bigint] as const)),
  ]);

  const balances = new Map<string, bigint>();
  let sumTracked = 0n;
  for (const [a, b] of bals) {
    balances.set(a, b);
    sumTracked += b;
  }

  return { token: tokenAddr, symbol: String(symbol), decimals: Number(decimals), totalSupply, balances, sumTracked };
}

export function diffSnapshots(before: BalanceSnapshot, after: BalanceSnapshot) {
  const keys = uniqAddrs([...before.balances.keys(), ...after.balances.keys()]);
  const diffs: Array<{ addr: string; before: bigint; after: bigint; delta: bigint }> = [];
  for (const a of keys) {
    const b0 = before.balances.get(a) ?? 0n;
    const b1 = after.balances.get(a) ?? 0n;
    const d = b1 - b0;
    if (d !== 0n) diffs.push({ addr: a, before: b0, after: b1, delta: d });
  }
  diffs.sort((x, y) => {
    const ax = x.delta < 0n ? -x.delta : x.delta;
    const ay = y.delta < 0n ? -y.delta : y.delta;
    return ay > ax ? 1 : ay < ax ? -1 : 0;
  });
  return diffs;
}

export function assertConservation(label: string, before: BalanceSnapshot, after: BalanceSnapshot) {
  if (before.totalSupply !== after.totalSupply) {
    throw new Error(`[${label}] totalSupply changed: before=${before.totalSupply.toString()} after=${after.totalSupply.toString()}`);
  }
  if (before.sumTracked !== after.sumTracked) {
    const diffs = diffSnapshots(before, after);
    const lines = diffs
      .slice(0, 30)
      .map(
        (d) =>
          `  - ${shortAddr(d.addr)} delta=${fmtAmount(d.delta, before.decimals)} (${d.delta.toString()}) ` +
          `before=${fmtAmount(d.before, before.decimals)} after=${fmtAmount(d.after, before.decimals)}`
      )
      .join("\n");
    throw new Error(
      `[${label}] sumTracked changed: before=${fmtAmount(before.sumTracked, before.decimals)} after=${fmtAmount(
        after.sumTracked,
        after.decimals
      )}\nDiffs (top 30 by abs delta):\n${lines}\nHint: funds likely flowed to/from an untracked address.`
    );
  }
}

/**
 * Derives a "tracked address set" from SSOT configuration.
 * This is intentionally best-effort: if a module is missing, it logs and continues.
 */
export async function discoverTrackedAddresses(opts: {
  include?: string[];
  borrower?: string;
  lender?: string;
  keeper?: string;
}) {
  const include = opts.include ?? [];
  const borrower = opts.borrower ?? ethers.ZeroAddress;
  const lender = opts.lender ?? ethers.ZeroAddress;
  const keeper = opts.keeper ?? ethers.ZeroAddress;

  const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
  const feeRouterAddr = (await registry.getModuleOrRevert(key("FEE_ROUTER"))) as string;
  const feeRouter = (await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", feeRouterAddr)) as any;

  const platformTreasury = (await feeRouter.getPlatformTreasury()) as string;
  const ecosystemVault = (await feeRouter.getEcosystemVault()) as string;

  const modules: Record<string, string> = {};
  const keysToFetch = [
    "VAULT_CORE",
    "VAULT_BUSINESS_LOGIC",
    "COLLATERAL_MANAGER",
    "ORDER_ENGINE",
    "SETTLEMENT_MANAGER",
    "LENDER_POOL_VAULT",
    "LIQUIDATION_MANAGER",
    "LIQUIDATION_PAYOUT_MANAGER",
    "LOAN_NFT",
    "PRICE_ORACLE",
    "VAULT_ROUTER",
  ];
  for (const k of keysToFetch) {
    try {
      modules[k] = (await registry.getModuleOrRevert(key(k))) as string;
    } catch {
      // skip
    }
  }

  // LPM recipients (if available)
  let lpmRecipients: string[] = [];
  if (modules["LIQUIDATION_PAYOUT_MANAGER"]) {
    try {
      const lpm = await ethers.getContractAt(
        ["function getRecipients() view returns (tuple(address platform,address reserve,address lenderCompensation))"],
        modules["LIQUIDATION_PAYOUT_MANAGER"]
      );
      const r = (await lpm.getRecipients()) as { platform: string; reserve: string; lenderCompensation: string };
      lpmRecipients = [r.platform, r.reserve, r.lenderCompensation];
    } catch {
      // skip
    }
  }

  // VaultCore.viewContractAddrVar() (router/view contract) as an extra sink/source
  let viewAddr = ethers.ZeroAddress;
  if (modules["VAULT_CORE"]) {
    try {
      const vc = await ethers.getContractAt(["function viewContractAddrVar() view returns (address)"], modules["VAULT_CORE"]);
      viewAddr = (await vc.viewContractAddrVar()) as string;
    } catch {
      // skip
    }
  }

  return uniqAddrs([
    ...include,
    borrower,
    lender,
    keeper,
    feeRouterAddr,
    platformTreasury,
    ecosystemVault,
    viewAddr,
    ...Object.values(modules),
    ...lpmRecipients,
  ]);
}

