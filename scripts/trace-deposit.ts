import hre from "hardhat";
import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../frontend-config/contracts-localhost";

async function main() {
  const [deployer, borrower] = await ethers.getSigners();

  const vc = (await ethers.getContractAt("VaultCore", CONTRACT_ADDRESSES.VaultCore)) as any;
  const usdc = (await ethers.getContractAt("MockERC20", CONTRACT_ADDRESSES.MockUSDC)) as any;
  const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;
  const aw = (await ethers.getContractAt("AssetWhitelist", CONTRACT_ADDRESSES.AssetWhitelist)) as any;
  const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", CONTRACT_ADDRESSES.PriceOracle)) as any;
  const vr = (await ethers.getContractAt("VaultRouter", CONTRACT_ADDRESSES.VaultRouter)) as any;

  const ACTION_DEPOSIT = ethers.keccak256(ethers.toUtf8Bytes("DEPOSIT"));
  const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes("SET_PARAMETER"));

  const ensureRole = async (role: string, who: string) => {
    if (!(await acm.hasRole(role, who))) await acm.grantRole(role, who);
  };

  await ensureRole(ACTION_DEPOSIT, CONTRACT_ADDRESSES.VaultCore);
  await ensureRole(ACTION_DEPOSIT, CONTRACT_ADDRESSES.VaultRouter);

  if (!(await aw.isAssetAllowed(usdc.target))) {
    await aw.connect(deployer).addAllowedAsset(usdc.target);
  }
  {
    const cfg = await po.getAssetConfig(usdc.target);
    if (!cfg.isActive) {
      await po.connect(deployer).configureAsset(usdc.target, "usd-coin", 8, 3600);
    }
  }
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  await po.connect(deployer).updatePrice(usdc.target, ethers.parseUnits("1", 6), now);

  await ensureRole(ACTION_SET_PARAMETER, deployer.address);
  await vr.connect(deployer).setTestingMode(true);

  await usdc.connect(deployer).transfer(borrower.address, ethers.parseUnits("10000", 6));
  await usdc.connect(borrower).approve(CONTRACT_ADDRESSES.VaultCore, ethers.MaxUint256);

  const amount = ethers.parseUnits("1000", 6);
  const txReq = await vc.connect(borrower).deposit.populateTransaction(usdc.target, amount);

  const call = {
    from: borrower.address,
    to: CONTRACT_ADDRESSES.VaultCore,
    data: txReq.data,
    gas: "0x7a1200", // 8_000_000
    value: "0x0",
  };

  console.log("debug_traceCall deposit...", call);

  try {
    // Hardhat http provider only supports default tracer; keep this block for future compatibility.
    const traced = await hre.network.provider.send("debug_traceCall", [call, "latest", { tracer: "callTracer" }]);
    console.dir(traced, { depth: 20 });
  } catch (e: any) {
    console.log("debug_traceCall(callTracer) failed:", e.shortMessage ?? e.message);
    const traced = await hre.network.provider.send("debug_traceCall", [call, "latest", {}]);
    const logs: any[] = traced.structLogs ?? [];
    console.log("structLogs length", logs.length);

    // Find the last few REVERTs and reconstruct revert data from memory+stack
    let shown = 0;
    for (let i = logs.length - 1; i >= 0; i--) {
      const row = logs[i];
      if (row?.op !== "REVERT") continue;
      const stack: string[] = row.stack ?? [];
      const mem: string[] = row.memory ?? [];
      const norm = (h: string) => (h.startsWith("0x") ? h : "0x" + h);
      const sizeHex = norm(stack[stack.length - 1] ?? "0");
      const offsetHex = norm(stack[stack.length - 2] ?? "0");
      const size = BigInt(sizeHex);
      const offset = BigInt(offsetHex);
      console.log("REVERT at pc", row.pc, "depth", row.depth, "offset", offset.toString(), "size", size.toString());
      if (size === 0n) {
        console.log("revert data: 0x (empty)");
      } else {
        // memory is array of 32-byte words as hex strings (hardhat usually omits 0x)
        const memBytes = Buffer.concat(
          mem.map((w) => Buffer.from((w.startsWith("0x") ? w.slice(2) : w).padStart(64, "0"), "hex"))
        );
        const slice = memBytes.subarray(Number(offset), Number(offset + size));
        console.log("revert data:", "0x" + slice.toString("hex"));
      }

      shown++;
      if (shown >= 6) break;
    }

    // Also print the tail ops for quick context
    for (const row of logs.slice(-40)) {
      console.log(row.pc, row.op, row.gas, row.depth);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});


