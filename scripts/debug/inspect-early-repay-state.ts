import { ethers, network } from "hardhat";

import { envStr, loadAddressMap, resolveAddress } from "../tests/_addressResolver";

function key(name: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

async function main() {
  const borrower = envStr("DEBUG_BORROWER_ADDRESS");
  const asset = envStr("DEBUG_ASSET_ADDRESS") ?? envStr("SETTLEMENT_TOKEN_ADDRESS");
  const actualRepay = envStr("DEBUG_ACTUAL_REPAY_UNITS");
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

  const ergm = (await ethers.getContractAt(
    [
      "function getUserGuaranteeId(address,address) view returns (uint256)",
      "function getGuaranteeRecord(uint256) view returns ((uint256 principal,uint256 promisedInterest,uint256 startTime,uint256 maturityTime,uint256 earlyRepayPenaltyDays,bool isActive,address lender,address asset))",
      "function previewEarlyRepayment(uint256,uint256) view returns ((uint256 penaltyToLender,uint256 refundToBorrower,uint256 platformFee,uint256 actualInterestPaid))",
    ],
    ergmAddr,
  )) as any;
  const gfm = (await ethers.getContractAt(
    [
      "function getLockedGuarantee(address,address) view returns (uint256)",
    ],
    gfmAddr,
  )) as any;
  const feeRouter = (await ethers.getContractAt(
    [
      "function isTokenSupported(address) view returns (bool)",
      "function getPlatformFeeBps() view returns (uint256)",
      "function getEcosystemFeeBps() view returns (uint256)",
      "function getPlatformTreasury() view returns (address)",
      "function getEcosystemVault() view returns (address)",
    ],
    feeRouterAddr,
  )) as any;
  const token = (await ethers.getContractAt(
    ["function balanceOf(address) view returns (uint256)"],
    asset,
  )) as any;

  const guaranteeId = (await ergm.getUserGuaranteeId(borrower, asset)) as bigint;
  const record = (await ergm.getGuaranteeRecord(guaranteeId)) as any;
  const preview = (await ergm.previewEarlyRepayment(guaranteeId, BigInt(actualRepay))) as any;
  const locked = (await gfm.getLockedGuarantee(borrower, asset)) as bigint;
  const gfmTokenBalance = (await token.balanceOf(gfmAddr)) as bigint;

  console.log(`Registry=${registryAddr}`);
  console.log(`Borrower=${borrower}`);
  console.log(`Asset=${asset}`);
  console.log(`GuaranteeFundManager=${gfmAddr}`);
  console.log(`FeeRouter=${feeRouterAddr}`);
  console.log(`GuaranteeId=${guaranteeId.toString()}`);
  console.log(`Record.promisedInterest=${record.promisedInterest.toString()}`);
  console.log(`Record.isActive=${record.isActive}`);
  console.log(`Record.lender=${record.lender}`);
  console.log(`Preview.penaltyToLender=${preview.penaltyToLender.toString()}`);
  console.log(`Preview.refundToBorrower=${preview.refundToBorrower.toString()}`);
  console.log(`Preview.platformFee=${preview.platformFee.toString()}`);
  console.log(`Preview.actualInterestPaid=${preview.actualInterestPaid.toString()}`);
  console.log(`Preview.sum=${(preview.penaltyToLender + preview.refundToBorrower + preview.platformFee).toString()}`);
  console.log(`Locked=${locked.toString()}`);
  console.log(`GfmTokenBalance=${gfmTokenBalance.toString()}`);
  console.log(`FeeRouter.supported=${await feeRouter.isTokenSupported(asset)}`);
  console.log(`FeeRouter.platformBps=${(await feeRouter.getPlatformFeeBps()).toString()}`);
  console.log(`FeeRouter.ecoBps=${(await feeRouter.getEcosystemFeeBps()).toString()}`);
  console.log(`FeeRouter.platformTreasury=${await feeRouter.getPlatformTreasury()}`);
  console.log(`FeeRouter.ecosystemVault=${await feeRouter.getEcosystemVault()}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});