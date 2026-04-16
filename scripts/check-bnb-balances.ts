import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const envPath = path.join(process.cwd(), ".env");
  const envContent = fs.readFileSync(envPath, "utf8");
  const env: Record<string, string> = {};

  envContent.split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const [key, ...valueParts] = trimmed.split("=");
    if (key) {
      env[key.trim()] = valueParts.join("=").trim();
    }
  });

  console.log("=== BNB Testnet Account Balance Check ===\n");

  const accounts = [
    { label: "Deployer (PRIVATE_KEY)", pk: env.PRIVATE_KEY },
    { label: "Borrower (BORROWER_PRIVATE_KEY)", pk: env.BORROWER_PRIVATE_KEY },
    { label: "Lender (LENDER_PRIVATE_KEY)", pk: env.LENDER_PRIVATE_KEY },
  ];

  for (const account of accounts) {
    if (!account.pk) {
      console.log(`${account.label}: NOT CONFIGURED\n`);
      continue;
    }

    try {
      const wallet = new ethers.Wallet(account.pk);
      const balance = await ethers.provider.getBalance(wallet.address);
      const balanceEther = ethers.formatEther(balance);

      console.log(`${account.label}:`);
      console.log(`  Address: ${wallet.address}`);
      console.log(`  Balance: ${balanceEther} tBNB`);

      // Check if balance is sufficient
      const needsRecharge = parseFloat(balanceEther) < 0.5; // Less than 0.5 BNB
      if (needsRecharge) {
        console.log(`  ⚠️  LOW BALANCE - recommend recharge\n`);
      } else {
        console.log(`  ✅ Sufficient\n`);
      }
    } catch (error) {
      console.log(`${account.label}: ERROR - ${(error as Error).message}\n`);
    }
  }

  // Check viewer address
  if (env.VIEWER_ADDRESS) {
    try {
      const balance = await ethers.provider.getBalance(env.VIEWER_ADDRESS);
      const balanceEther = ethers.formatEther(balance);
      console.log(`Viewer (VIEWER_ADDRESS):`);
      console.log(`  Address: ${env.VIEWER_ADDRESS}`);
      console.log(`  Balance: ${balanceEther} tBNB\n`);
    } catch (error) {
      console.log(`Viewer: ERROR - ${(error as Error).message}\n`);
    }
  }

  // Summary
  console.log("=== Summary ===");
  console.log("Recommended minimum per account: 0.5 tBNB");
  console.log("BNB Testnet faucet: https://testnet.binance.org/faucet-smart");
}

main().catch(console.error);
