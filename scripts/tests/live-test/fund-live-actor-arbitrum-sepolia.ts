import { ethers, network } from "hardhat";

// 给 live 测试参与者补一点原生 gas 资金，常用于单独准备 borrower / lender 账号。
async function main() {
  const to = process.env.FUND_TO?.trim();
  const amountEth = process.env.FUND_AMOUNT_ETH?.trim() || "0.002";

  // 目标地址必须显式提供，避免误转给默认账号。
  if (!to) {
    throw new Error("missing FUND_TO");
  }

  const [sender] = await ethers.getSigners();
  const tx = await sender.sendTransaction({
    to,
    value: ethers.parseEther(amountEth),
  });

  console.log(`Network=${network.name}`);
  console.log(`Sender=${sender.address}`);
  console.log(`Recipient=${to}`);
  console.log(`AmountEth=${amountEth}`);
  console.log(`TxHash=${tx.hash}`);

  await tx.wait();

  console.log("✅ fund-live-actor-arbitrum-sepolia PASSED");
}

main().catch((error) => {
  console.error("\n❌ fund-live-actor-arbitrum-sepolia FAILED\n");
  console.error(error);
  process.exit(1);
});