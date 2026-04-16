import { Interface } from "ethers";
import { ethers, network } from "hardhat";

import { decodeRevert } from "../utils/decodeRevert";
import { envStr, loadAddressMap, resolveAddress } from "../tests/_addressResolver";

function key(name: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

function extractRevertData(error: any): string {
  const data = error?.data ?? error?.error?.data ?? error?.info?.error?.data ?? error?.info?.data;
  if (typeof data === "string") return data;
  if (data && typeof data === "object" && typeof data.data === "string") return data.data;
  return "0x";
}

function explain(error: any, ifaces: Interface[]) {
  const revertData = extractRevertData(error);
  for (const iface of ifaces) {
    try {
      const parsed = iface.parseError(revertData);
      if (parsed) {
        return `${parsed.name}(${parsed.args.map((arg: unknown) => String(arg)).join(", ")})`;
      }
    } catch {
      // ignore
    }
  }
  return decodeRevert(revertData);
}

async function main() {
  const borrower = envStr("DEBUG_BORROWER_ADDRESS");
  const asset = envStr("DEBUG_ASSET_ADDRESS") ?? envStr("SETTLEMENT_TOKEN_ADDRESS");
  const actualRepay = envStr("DEBUG_ACTUAL_REPAY_UNITS");
   const orderId = envStr("DEBUG_ORDER_ID");
   if (!borrower || !asset || !actualRepay) {
     throw new Error("set DEBUG_BORROWER_ADDRESS, DEBUG_ASSET_ADDRESS/SETTLEMENT_TOKEN_ADDRESS, DEBUG_ACTUAL_REPAY_UNITS");
  }

  const addressMap = loadAddressMap(network.name, { preferMockSuite: true });
  const registryAddr = resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });
  const registry = (await ethers.getContractAt(
    [
      "function getModule(bytes32) view returns (address)",
      "function getModuleOrRevert(bytes32) view returns (address)",
    ],
    registryAddr,
  )) as any;

  const ergmAddr = (await registry.getModule(key("EARLY_REPAYMENT_GUARANTEE_MANAGER"))) as string;
  const gfmAddr = (await registry.getModule(key("GUARANTEE_FUND_MANAGER"))) as string;
  const feeRouterAddr = (await registry.getModuleOrRevert(key("FEE_ROUTER"))) as string;
   const settlementManagerAddr = (await registry.getModule(key("SETTLEMENT_MANAGER"))) as string;
   const vaultCoreAddr = (await registry.getModuleOrRevert(key("VAULT_CORE"))) as string;

  const ergm = (await ethers.getContractAt(
    [
      "function getUserGuaranteeId(address,address) view returns (uint256)",
      "function getGuaranteeRecord(uint256) view returns ((uint256 principal,uint256 promisedInterest,uint256 startTime,uint256 maturityTime,uint256 earlyRepayPenaltyDays,bool isActive,address lender,address asset))",
      "function previewEarlyRepayment(uint256,uint256) view returns ((uint256 penaltyToLender,uint256 refundToBorrower,uint256 platformFee,uint256 actualInterestPaid))",
    ],
    ergmAddr,
  )) as any;

  const guaranteeId = (await ergm.getUserGuaranteeId(borrower, asset)) as bigint;
  const record = (await ergm.getGuaranteeRecord(guaranteeId)) as any;
  const preview = (await ergm.previewEarlyRepayment(guaranteeId, BigInt(actualRepay))) as any;

  const gfmInterface = new ethers.Interface([
    "function settleEarlyRepayment(address user,address asset,address lender,uint256 refundToBorrower,uint256 penaltyToLender,uint256 platformFee)",
    "error GuaranteeFundManager__OnlyAuthorizedCaller()",
    "error AmountMismatch()",
    "error ZeroAddress()",
    "error NotEnoughGuarantee()",
  ]);
  const feeRouterInterface = new ethers.Interface([
    "function distributePrepaid(address token,uint256 amount,bytes32 feeType,address payer)",
    "error FeeRouter__TokenNotSupported()",
    "error FeeRouter__InvalidConfig()",
    "error FeeRouter__InsufficientBalance(uint256 balance,uint256 required)",
    "error MissingRole()",
    "error AmountIsZero()",
  ]);
   const settlementManagerInterface = new ethers.Interface([
     "function repayAndSettle(address user,address debtAsset,uint256 repayAmount,uint256 orderId)",
     "error SettlementManager__OnlyVaultCore()",
     "error SettlementManager__InvalidOrderId()",
     "error SettlementManager__NotLiquidatable()",
     "error SettlementManager__NoCollateral()",
     "error SettlementManager__OrderMismatch()",
     "error SettlementManager__DebtNotCleared()",
   ]);
  const vaultCoreInterface = new ethers.Interface([
    "function repay(uint256 orderId,address asset,uint256 amount)",
  ]);
  const erc20Interface = new ethers.Interface([
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "error ERC20InsufficientBalance(address sender,uint256 balance,uint256 needed)",
    "error ERC20InsufficientAllowance(address spender,uint256 allowance,uint256 needed)",
    "error ERC20InvalidSender(address sender)",
    "error ERC20InvalidReceiver(address receiver)",
  ]);

  const feeType = ethers.keccak256(ethers.toUtf8Bytes("EARLY_REPAYMENT_PLATFORM"));
  const gfmData = gfmInterface.encodeFunctionData("settleEarlyRepayment", [
    borrower,
    asset,
    record.lender,
    preview.refundToBorrower,
    preview.penaltyToLender,
    preview.platformFee,
  ]);
  const feeRouterData = feeRouterInterface.encodeFunctionData("distributePrepaid", [
    asset,
    preview.platformFee,
    feeType,
    borrower,
  ]);

  console.log(`Registry=${registryAddr}`);
  console.log(`Borrower=${borrower}`);
  console.log(`Asset=${asset}`);
  console.log(`GuaranteeId=${guaranteeId.toString()}`);
  console.log(`Preview.platformFee=${preview.platformFee.toString()}`);
  console.log(`Record.lender=${record.lender}`);

  try {
    const result = await ethers.provider.call({ from: ergmAddr, to: gfmAddr, data: gfmData });
    console.log(`GFM.settleEarlyRepayment call ok result=${result}`);
  } catch (error: any) {
    console.log(`GFM.settleEarlyRepayment call failed: ${explain(error, [gfmInterface, feeRouterInterface])}`);
  }

  try {
    const result = await ethers.provider.call({ from: gfmAddr, to: feeRouterAddr, data: feeRouterData });
    console.log(`FeeRouter.distributePrepaid call ok result=${result}`);
  } catch (error: any) {
    console.log(`FeeRouter.distributePrepaid call failed: ${explain(error, [feeRouterInterface, gfmInterface])}`);
  }

    if (orderId) {
      const settlementData = settlementManagerInterface.encodeFunctionData("repayAndSettle", [
        borrower,
        asset,
        BigInt(actualRepay),
        BigInt(orderId),
      ]);
      try {
        const result = await ethers.provider.call({ from: vaultCoreAddr, to: settlementManagerAddr, data: settlementData });
        console.log(`SettlementManager.repayAndSettle call ok result=${result}`);
      } catch (error: any) {
        console.log(
          `SettlementManager.repayAndSettle call failed: ${explain(error, [settlementManagerInterface, gfmInterface, feeRouterInterface])}`,
        );
      }
    const vaultCoreData = vaultCoreInterface.encodeFunctionData("repay", [
      BigInt(orderId),
      asset,
      BigInt(actualRepay),
    ]);
    try {
      const result = await ethers.provider.call({ from: borrower, to: vaultCoreAddr, data: vaultCoreData });
      console.log(`VaultCore.repay call ok result=${result}`);
    } catch (error: any) {
      console.log(
        `VaultCore.repay call failed: ${explain(error, [vaultCoreInterface, settlementManagerInterface, gfmInterface, feeRouterInterface, erc20Interface])}`,
      );
    }
    }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});