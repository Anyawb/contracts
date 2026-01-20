import hre from "hardhat";
import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../frontend-config/contracts-localhost";

function norm(h: string) {
  return h.startsWith("0x") ? h : "0x" + h;
}

async function main() {
  const pvAddr = CONTRACT_ADDRESSES.PositionView;
  const vrAddr = CONTRACT_ADDRESSES.VaultRouter;
  const usdcAddr = CONTRACT_ADDRESSES.MockUSDC;
  const [, borrower] = await ethers.getSigners();

  const pv = await ethers.getContractAt("src/Vault/view/modules/PositionView.sol:PositionView", pvAddr);
  const data = pv.interface.encodeFunctionData("pushUserPositionUpdateDelta(address,address,int256,int256,uint64)", [
    borrower.address,
    usdcAddr,
    1n,
    0n,
    1,
  ]);

  const call = { from: vrAddr, to: pvAddr, data, gas: "0x7a1200", value: "0x0" };
  console.log("debug_traceCall PV.pushUserPositionUpdateDelta from VaultRouter", call);

  const traced = await hre.network.provider.send("debug_traceCall", [call, "latest", {}]);
  const logs: any[] = traced.structLogs ?? [];
  console.log("structLogs length", logs.length);

  let shown = 0;
  for (let i = logs.length - 1; i >= 0; i--) {
    const row = logs[i];
    if (row?.op !== "REVERT") continue;
    const stack: string[] = row.stack ?? [];
    const mem: string[] = row.memory ?? [];
    const size = BigInt(norm(stack[stack.length - 1] ?? "0"));
    const offset = BigInt(norm(stack[stack.length - 2] ?? "0"));
    console.log("REVERT at pc", row.pc, "depth", row.depth, "offset", offset.toString(), "size", size.toString());
    if (size === 0n) {
      console.log("revert data: 0x (empty)");
    } else {
      const memBytes = Buffer.concat(
        mem.map((w) => Buffer.from((w.startsWith("0x") ? w.slice(2) : w).padStart(64, "0"), "hex"))
      );
      const slice = memBytes.subarray(Number(offset), Number(offset + size));
      console.log("revert data:", "0x" + slice.toString("hex"));
    }
    shown++;
    if (shown >= 6) break;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
