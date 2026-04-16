import { FeeData, formatUnits, parseUnits } from "ethers";

const PATCH_FLAG = Symbol.for("contracts.dynamicEip1559FeePatch");

function parseGweiEnv(name: string): bigint | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  return parseUnits(raw, 9);
}

function parsePositiveIntEnv(name: string, fallback: number): bigint {
  const raw = process.env[name]?.trim();
  if (!raw) return BigInt(fallback);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return BigInt(fallback);
  return BigInt(parsed);
}

function shouldPatchFees(networkName: string, force?: boolean) {
  if (force === true) return true;
  if (force === false) return false;
  return networkName === "arbitrumSepolia" || networkName === "arbitrum" || networkName === "bnbTestnet";
}

export async function configureDynamicEip1559Fees(opts: {
  ethers: { provider: any };
  networkName: string;
  label?: string;
  force?: boolean;
}) {
  if (!shouldPatchFees(opts.networkName, opts.force)) return;

  const provider = opts.ethers.provider as any;
  if (!provider || provider[PATCH_FLAG]) return;

  const label = opts.label ?? opts.networkName;
  const originalGetFeeData = provider.getFeeData.bind(provider);

  provider.getFeeData = async () => {
    const original = await originalGetFeeData();
    const latest = await provider.getBlock("latest");

    const configuredPriority = parseGweiEnv("TX_MAX_PRIORITY_FEE_GWEI");
    const defaultPriority = parseGweiEnv("TX_DEFAULT_PRIORITY_FEE_GWEI") ?? parseUnits("0.01", 9);
    let priority = configuredPriority ?? original.maxPriorityFeePerGas ?? 0n;

    if (priority === 0n) {
      try {
        const rpcPriority = (await provider.send("eth_maxPriorityFeePerGas", [])) as string;
        if (rpcPriority) priority = BigInt(rpcPriority);
      } catch {
        priority = 0n;
      }
    }
    if (priority < defaultPriority) priority = defaultPriority;

    const fixedMaxFee = parseGweiEnv("TX_MAX_FEE_GWEI");
    const minMaxFee = parseGweiEnv("TX_MIN_MAX_FEE_GWEI") ?? parseUnits("0.05", 9);
    const baseMultiplier = parsePositiveIntEnv("TX_BASE_FEE_MULTIPLIER", 2);
    const baseFee = latest?.baseFeePerGas ?? original.lastBaseFeePerGas ?? 0n;

    let maxFee = fixedMaxFee ?? baseFee * baseMultiplier + priority;
    if (maxFee < minMaxFee) maxFee = minMaxFee;
    if (maxFee < priority) maxFee = priority;

    return new FeeData(null, maxFee, priority);
  };

  provider[PATCH_FLAG] = true;

  const preview = await provider.getFeeData();
  console.log(
    `[Gas] ${label}: dynamic EIP-1559 fees enabled maxFeePerGas=${formatUnits(preview.maxFeePerGas ?? 0n, 9)} gwei maxPriorityFeePerGas=${formatUnits(preview.maxPriorityFeePerGas ?? 0n, 9)} gwei`
  );
}