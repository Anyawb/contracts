import { ethers, network } from "hardhat";

async function main() {
  if (network.name !== "arbitrumSepolia") {
    throw new Error(`expected --network arbitrumSepolia, got ${network.name}`);
  }

  const borrowerPk = process.env.BORROWER_PRIVATE_KEY;
  const tokenAddr = process.env.SETTLEMENT_TOKEN_ADDRESS;
  const amountRaw = process.env.FUND_AMOUNT_UNITS ?? "5";

  if (!borrowerPk) {
    throw new Error("BORROWER_PRIVATE_KEY is required");
  }
  if (!tokenAddr) {
    throw new Error("SETTLEMENT_TOKEN_ADDRESS is required");
  }

  const [relayer] = await ethers.getSigners();
  const borrower = new ethers.Wallet(borrowerPk, ethers.provider);
  const token = (await ethers.getContractAt(
    [
      "function transfer(address to,uint256 amount) returns (bool)",
      "function balanceOf(address owner) view returns (uint256)",
      "function decimals() view returns (uint8)",
      "function symbol() view returns (string)",
    ],
    tokenAddr,
    relayer,
  )) as any;

  const decimals = Number(await token.decimals());
  const symbol = String(await token.symbol());
  const amount = ethers.parseUnits(amountRaw, decimals);
  const before = (await token.balanceOf(borrower.address)) as bigint;
  await (await token.transfer(borrower.address, amount)).wait();
  const after = (await token.balanceOf(borrower.address)) as bigint;

  console.log(`Relayer=${relayer.address}`);
  console.log(`Borrower=${borrower.address}`);
  console.log(`Token=${tokenAddr}`);
  console.log(`Amount=${ethers.formatUnits(amount, decimals)} ${symbol}`);
  console.log(`BorrowerBalance.before=${before}`);
  console.log(`BorrowerBalance.after=${after}`);
}

main().catch((error) => {
  console.error("\n❌ fund-live-borrower FAILED\n");
  console.error(error);
  process.exit(1);
});