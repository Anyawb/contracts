import hre from "hardhat";
import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../frontend-config/contracts-localhost.ts";

async function main() {
  const [deployer, borrower] = await ethers.getSigners();

  const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
  const acmAddrFromRegistry = (await registry.getModuleOrRevert(ethers.keccak256(ethers.toUtf8Bytes("ACCESS_CONTROL_MANAGER")))) as string;
  const assetWhitelistAddrFromRegistry = (await registry.getModuleOrRevert(ethers.keccak256(ethers.toUtf8Bytes("ASSET_WHITELIST")))) as string;
  const priceOracleAddrFromRegistry = (await registry.getModuleOrRevert(ethers.keccak256(ethers.toUtf8Bytes("PRICE_ORACLE")))) as string;
  const settlementTokenAddrFromRegistry = (await registry.getModuleOrRevert(ethers.keccak256(ethers.toUtf8Bytes("SETTLEMENT_TOKEN")))) as string;
  const vaultCoreFromRegistryAddr = (await registry.getModuleOrRevert(ethers.keccak256(ethers.toUtf8Bytes("VAULT_CORE")))) as string;

  const vc = (await ethers.getContractAt("VaultCore", vaultCoreFromRegistryAddr)) as any;
  const usdc = (await ethers.getContractAt("MockERC20", settlementTokenAddrFromRegistry)) as any;
  const acm = (await ethers.getContractAt("AccessControlManager", acmAddrFromRegistry)) as any;
  const aw = (await ethers.getContractAt("AssetWhitelist", assetWhitelistAddrFromRegistry)) as any;
  const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", priceOracleAddrFromRegistry)) as any;
  const vaultRouterAddr = (await vc.viewContractAddrVar()) as string;
  const vr = (await ethers.getContractAt("VaultRouter", vaultRouterAddr)) as any;

  const ACTION_DEPOSIT = ethers.keccak256(ethers.toUtf8Bytes("DEPOSIT"));
  const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes("SET_PARAMETER"));

  const ensureRole = async (role: string, who: string) => {
    if (!(await acm.hasRole(role, who))) await acm.grantRole(role, who);
  };

  await ensureRole(ACTION_DEPOSIT, vaultCoreFromRegistryAddr);
  await ensureRole(ACTION_DEPOSIT, vaultRouterAddr);

  if (!(await aw.isAssetAllowed(settlementTokenAddrFromRegistry))) {
    await aw.connect(deployer).addAllowedAsset(settlementTokenAddrFromRegistry);
  }
  {
    const cfg = await po.getAssetConfig(settlementTokenAddrFromRegistry);
    if (!cfg.isActive) {
      const usdcDecimals = Number(await usdc.decimals().catch(() => 6));
      await po.connect(deployer).configureAsset(settlementTokenAddrFromRegistry, "usd-coin", usdcDecimals, 3600);
    }
  }
  const blockNumber = await ethers.provider.getBlockNumber();
  // SSOT: price is USD-8 ($1.00 = 100000000)
  await po.connect(deployer).updatePrice(settlementTokenAddrFromRegistry, ethers.parseUnits("1", 8), blockNumber);

  // Optional (legacy): enable router testing mode if supported by deployed VaultRouter.
  await ensureRole(ACTION_SET_PARAMETER, deployer.address);
  if (typeof (vr as any).setTestingMode === "function") {
    await vr.connect(deployer).setTestingMode(true);
    console.log("ℹ️  VaultRouter.setTestingMode(true) enabled");
  } else {
    console.log("ℹ️  VaultRouter.setTestingMode not found on this deployment; skipping");
  }

  await usdc.connect(deployer).transfer(borrower.address, ethers.parseUnits("10000", 6));
  await usdc.connect(borrower).approve(vaultCoreFromRegistryAddr, ethers.MaxUint256);

  const amount = ethers.parseUnits("1000", 6);
  const txReq = await vc.connect(borrower).deposit.populateTransaction(settlementTokenAddrFromRegistry, amount);

  const call = {
    from: borrower.address,
    to: vaultCoreFromRegistryAddr,
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


