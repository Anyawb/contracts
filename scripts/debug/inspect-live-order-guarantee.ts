import "dotenv/config";
import { ethers, network } from "hardhat";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { envStr, loadAddressMap, resolveAddress } from "../tests/_addressResolver";

function key(name: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

async function callOrderEngineWithFrom(
  orderEngineAddr: string,
  functionFragment: string,
  functionName: "getLoanOrderForView" | "getOrderTotalDueForView",
  args: readonly unknown[],
  from: string,
) {
  const iface = new ethers.Interface([functionFragment]);
  const result = await ethers.provider.call({
    to: orderEngineAddr,
    from,
    data: iface.encodeFunctionData(functionName, args),
  });
  return iface.decodeFunctionResult(functionName, result);
}

async function readOrderTotalDueWithFallback(
  orderEngineAddr: string,
  orderId: bigint,
  candidateCallers: string[],
) {
  let lastError: unknown;
  for (const caller of candidateCallers) {
    try {
      const [rawTotalDue] = await callOrderEngineWithFrom(
        orderEngineAddr,
        "function getOrderTotalDueForView(uint256 orderId) view returns (uint256)",
        "getOrderTotalDueForView",
        [orderId],
        caller,
      );
      return { totalDue: BigInt(rawTotalDue ?? 0), caller };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function main() {
  const orderId = BigInt(envStr("DEBUG_ORDER_ID") ?? "408");

  const addressMap = loadAddressMap(network.name, { preferMockSuite: true });
  let registryAddr = "";
  try {
    registryAddr = resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });
  } catch {
    // Align with live docs: allow DEPLOY_OUTPUT_FILE (default bnb profile points to scripts/deployments/bnb-testnet/core.json).
    const deployOutput = envStr("DEPLOY_OUTPUT_FILE")
      ?? (network.name === "bnbTestnet" ? "scripts/deployments/bnb-testnet/core.json" : undefined);
    if (!deployOutput) {
      throw new Error("Missing Registry address. Set REGISTRY_ADDRESS or DEPLOY_OUTPUT_FILE.");
    }
    const deployOutputPath = path.isAbsolute(deployOutput)
      ? deployOutput
      : path.resolve(process.cwd(), deployOutput);
    if (!existsSync(deployOutputPath)) {
      throw new Error(`Missing deploy output file: ${deployOutputPath}`);
    }
    const parsed = JSON.parse(readFileSync(deployOutputPath, "utf8")) as Record<string, unknown>;
    const candidate = String(parsed.Registry ?? "").trim();
    if (!candidate || !ethers.isAddress(candidate)) {
      throw new Error(`Registry not found in deploy output: ${deployOutputPath}`);
    }
    registryAddr = candidate;
  }
  const registry = (await ethers.getContractAt(
    [
      "function getModule(bytes32) view returns (address)",
      "function getModuleOrRevert(bytes32) view returns (address)",
    ],
    registryAddr,
  )) as any;

  const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;
  const settlementManagerAddr = (await registry.getModuleOrRevert(key("SETTLEMENT_MANAGER"))) as string;
  const ergmAddr = (await registry.getModuleOrRevert(key("EARLY_REPAYMENT_GUARANTEE_MANAGER"))) as string;
  const gfmAddr = (await registry.getModuleOrRevert(key("GUARANTEE_FUND_MANAGER"))) as string;

  const orderEngine = (await ethers.getContractAt(
    ["function getLoanOrderForView(uint256 orderId) view returns (tuple(uint256 principal,uint256 rate,uint256 term,address borrower,address lender,address asset,uint256 startBlock,uint256 maturity,uint256 repaidAmount))"],
    orderEngineAddr,
  )) as any;

  const rawOrder = (await orderEngine.getLoanOrderForView(orderId)) as any;
  const [runtimeSigner] = await ethers.getSigners();
  const signerAddress = runtimeSigner.address;
  const viewerAddress = envStr("VIEWER_ADDRESS");
  const callers = [viewerAddress, signerAddress, settlementManagerAddr]
    .map((value) => String(value ?? "").trim())
    .filter((value, index, arr) => Boolean(value) && ethers.isAddress(value) && arr.indexOf(value) === index);
  const { totalDue: rawTotalDue, caller: totalDueCaller } = await readOrderTotalDueWithFallback(orderEngineAddr, orderId, callers);

  const order = rawOrder as any;
  const borrower = String(order.borrower ?? order[3] ?? ethers.ZeroAddress);
  const asset = String(order.asset ?? order[5] ?? ethers.ZeroAddress);

  const ergm = (await ethers.getContractAt(
    [
      "function isGuaranteeEnabled(address) view returns (bool)",
      "function getUserGuaranteeId(address,address) view returns (uint256)",
      "function hasActiveGuarantee(address,address) view returns (bool)",
      "function getGuaranteeRecord(uint256) view returns ((uint256 principal,uint256 promisedInterest,uint256 startTime,uint256 maturityTime,uint256 earlyRepayPenaltyDays,bool isActive,address lender,address asset))",
    ],
    ergmAddr,
  )) as any;
  const gfm = (await ethers.getContractAt(
    ["function getLockedGuarantee(address,address) view returns (uint256)"],
    gfmAddr,
  )) as any;

  const guaranteeEnabled = (await ergm.isGuaranteeEnabled(asset)) as boolean;
  const guaranteeId = (await ergm.getUserGuaranteeId(borrower, asset)) as bigint;
  const guaranteeActive = (await ergm.hasActiveGuarantee(borrower, asset)) as boolean;
  const lockedGuarantee = (await gfm.getLockedGuarantee(borrower, asset)) as bigint;

  let guaranteeRecord: Record<string, string | boolean> | null = null;
  if (guaranteeId > 0n) {
    const rawRecord = (await ergm.getGuaranteeRecord(guaranteeId)) as any;
    guaranteeRecord = {
      principal: String(rawRecord.principal ?? rawRecord[0] ?? 0),
      promisedInterest: String(rawRecord.promisedInterest ?? rawRecord[1] ?? 0),
      startTime: String(rawRecord.startTime ?? rawRecord[2] ?? 0),
      maturityTime: String(rawRecord.maturityTime ?? rawRecord[3] ?? 0),
      earlyRepayPenaltyDays: String(rawRecord.earlyRepayPenaltyDays ?? rawRecord[4] ?? 0),
      isActive: Boolean(rawRecord.isActive ?? rawRecord[5] ?? false),
      lender: String(rawRecord.lender ?? rawRecord[6] ?? ethers.ZeroAddress),
      asset: String(rawRecord.asset ?? rawRecord[7] ?? ethers.ZeroAddress),
    };
  }

  console.log(JSON.stringify({
    network: network.name,
    currentBlock: String(await ethers.provider.getBlockNumber()),
    registryAddr,
    orderEngineAddr,
    settlementManagerAddr,
    totalDueCaller,
    ergmAddr,
    gfmAddr,
    orderId: String(orderId),
    order: {
      principal: String(order.principal ?? order[0] ?? 0),
      rate: String(order.rate ?? order[1] ?? 0),
      term: String(order.term ?? order[2] ?? 0),
      borrower,
      lender: String(order.lender ?? order[4] ?? ethers.ZeroAddress),
      asset,
      startBlock: String(order.startBlock ?? order[6] ?? 0),
      maturity: String(order.maturity ?? order[7] ?? 0),
      repaidAmount: String(order.repaidAmount ?? order[8] ?? 0),
      totalDue: String(rawTotalDue ?? 0),
    },
    guarantee: {
      enabled: guaranteeEnabled,
      guaranteeId: String(guaranteeId),
      active: guaranteeActive,
      locked: String(lockedGuarantee),
      record: guaranteeRecord,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});