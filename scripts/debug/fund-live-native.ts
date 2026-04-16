import { ethers } from "hardhat";

import { envStr } from "../tests/_addressResolver";
import { createFundsFlowLiveContext } from "../tests/live-test/networks/arbitrum-sepolia/core/_fundsFlowLive";

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Fund Live Native",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  const targetAddress = envStr("DEBUG_NATIVE_ACCOUNT")?.trim() || ctx.relayer.address;
  const minBalanceWei = ethers.parseEther(envStr("DEBUG_NATIVE_MIN_ETH") ?? "0.0003");
  const sponsorReserveWei = ethers.parseEther(
    envStr("DEBUG_NATIVE_SPONSOR_RESERVE_ETH") ?? envStr("LIVE_FRESH_BORROWER_RELAYER_RESERVE_ETH") ?? "0.0002",
  );
  const beforeBalance = await ethers.provider.getBalance(targetAddress);

  console.log("=== Fund Live Native ===");
  console.log(`Target=${targetAddress}`);
  console.log(`Balance.before=${ethers.formatEther(beforeBalance)} ETH`);
  console.log(`Required.minimum=${ethers.formatEther(minBalanceWei)} ETH`);
  console.log(`Sponsor.reserve=${ethers.formatEther(sponsorReserveWei)} ETH`);

  if (beforeBalance >= minBalanceWei) {
    console.log("balance already sufficient; nothing to do");
    return;
  }

  let remainingTopUp = BigInt(minBalanceWei - beforeBalance);
  const seenSponsors = new Set<string>();
  const sponsors = [ctx.borrower, ctx.lender, ctx.viewer, ctx.updater].filter((signer): signer is NonNullable<typeof signer> => {
    if (!signer?.address) {
      return false;
    }
    const signerKey = signer.address.toLowerCase();
    if (signerKey === targetAddress.toLowerCase() || seenSponsors.has(signerKey)) {
      return false;
    }
    seenSponsors.add(signerKey);
    return true;
  });

  for (const sponsor of sponsors) {
    if (remainingTopUp === 0n) {
      break;
    }
    const sponsorBalance = await ethers.provider.getBalance(sponsor.address);
    const transferable = sponsorBalance > sponsorReserveWei ? sponsorBalance - sponsorReserveWei : 0n;
    const sendAmount = BigInt(transferable > remainingTopUp ? remainingTopUp : transferable);
    console.log(
      `Sponsor=${sponsor.address} balance=${ethers.formatEther(sponsorBalance)} ETH transferable=${ethers.formatEther(transferable)} ETH send=${ethers.formatEther(sendAmount)} ETH`,
    );
    if (sendAmount === 0n) {
      continue;
    }
    try {
      const receipt = await (await sponsor.sendTransaction({ to: targetAddress, value: sendAmount })).wait();
      console.log(`TopUpTx=${receipt?.hash ?? "unknown"}`);
      remainingTopUp -= sendAmount;
    } catch (error: any) {
      const message = String(error?.message ?? error?.shortMessage ?? "").toLowerCase();
      const code = String(error?.code ?? "").toUpperCase();
      if (code === "UNSUPPORTED_OPERATION" || message.includes("missing provider") || message.includes("unsupported operation") || message.includes("cannot sign transactions")) {
        console.log(`Sponsor=${sponsor.address} skipped: unusable signer for native top-up`);
        continue;
      }
      throw error;
    }
  }

  const afterBalance = await ethers.provider.getBalance(targetAddress);
  console.log(`Balance.after=${ethers.formatEther(afterBalance)} ETH`);
  if (afterBalance < minBalanceWei) {
    throw new Error(
      `target native balance still insufficient: have=${ethers.formatEther(afterBalance)} ETH required=${ethers.formatEther(minBalanceWei)} ETH`,
    );
  }
}

main().catch((error) => {
  console.error("\n❌ fund-live-native FAILED\n");
  console.error(error);
  process.exit(1);
});