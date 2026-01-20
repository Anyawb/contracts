import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../frontend-config/contracts-localhost";

function show(label: string, v: unknown) {
  console.log(label, v);
}

function extractRevertData(e: any): string {
  const d = e?.data ?? e?.error?.data;
  if (typeof d === "string") return d;
  if (d && typeof d === "object" && typeof d.data === "string") return d.data;
  return "0x";
}

function tryParseError(ifs: Array<{ name: string; iface: any }>, data: string) {
  for (const { name, iface } of ifs) {
    try {
      const parsed = iface.parseError(data);
      return { name, parsed };
    } catch {
      // ignore
    }
  }
  return null;
}

async function main() {
  const [deployer, borrower] = await ethers.getSigners();

  const registryAddr = CONTRACT_ADDRESSES.Registry;
  const vaultCoreAddr = CONTRACT_ADDRESSES.VaultCore;
  const vaultRouterAddr = CONTRACT_ADDRESSES.VaultRouter;
  const cmAddr = CONTRACT_ADDRESSES.CollateralManager;
  const usdcAddr = CONTRACT_ADDRESSES.MockUSDC;

  const vr = (await ethers.getContractAt("VaultRouter", vaultRouterAddr)) as any;
  const vc = (await ethers.getContractAt("VaultCore", vaultCoreAddr)) as any;
  const cm = (await ethers.getContractAt("CollateralManager", cmAddr)) as any;
  const usdc = (await ethers.getContractAt("MockERC20", usdcAddr)) as any;

  show("registry", registryAddr);
  show("vaultCore", vaultCoreAddr);
  show("vaultRouter", vaultRouterAddr);
  show("cm", cmAddr);
  show("usdc", usdcAddr);

  const ifs = [
    { name: "VaultRouter", iface: vr.interface },
    { name: "VaultCore", iface: vc.interface },
    { name: "CollateralManager", iface: cm.interface },
    { name: "MockERC20", iface: usdc.interface },
  ];

  const amount = ethers.parseUnits("1000", 6);
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;

  // Step 0: probe VaultCore push selector that CollateralManager uses
  {
    show("\\n[Step 0] provider.call VaultCore.pushUserPositionUpdateDelta(user,asset,int256,int256,bytes32,uint64,uint64) (from CM)", "");
    const data = vc.interface.encodeFunctionData("pushUserPositionUpdateDelta(address,address,int256,int256,bytes32,uint64,uint64)", [
      borrower.address,
      usdcAddr,
      1n,
      0n,
      ethers.ZeroHash,
      0,
      0,
    ]);
    try {
      await ethers.provider.call({ to: vaultCoreAddr, from: cmAddr, data });
      show("Step 0", "OK");
    } catch (e: any) {
      const revertData = extractRevertData(e);
      show("Step 0 revertData", revertData);
      const parsed = revertData !== "0x" ? tryParseError(ifs, revertData) : null;
      show("Step 0 parsed", parsed ? { contract: parsed.name, error: parsed.parsed?.name, args: parsed.parsed?.args } : "<unparsed>");
      show("Step 0 msg", e.shortMessage ?? e.message);
    }
  }

  // Step 0b: probe the shorter overload (user,asset,int256,int256) just in case
  {
    show("\\n[Step 0b] provider.call VaultCore.pushUserPositionUpdateDelta(user,asset,int256,int256) (from CM)", "");
    const data = vc.interface.encodeFunctionData("pushUserPositionUpdateDelta(address,address,int256,int256)", [
      borrower.address,
      usdcAddr,
      1n,
      0n,
    ]);
    try {
      await ethers.provider.call({ to: vaultCoreAddr, from: cmAddr, data });
      show("Step 0b", "OK");
    } catch (e: any) {
      const revertData = extractRevertData(e);
      show("Step 0b revertData", revertData);
      const parsed = revertData !== "0x" ? tryParseError(ifs, revertData) : null;
      show("Step 0b parsed", parsed ? { contract: parsed.name, error: parsed.parsed?.name, args: parsed.parsed?.args } : "<unparsed>");
      show("Step 0b msg", e.shortMessage ?? e.message);
    }
  }

  // Step A
  {
    show("\n[Step A] provider.call VaultRouter.processUserOperation (from VaultCore)", "");
    const data = vr.interface.encodeFunctionData("processUserOperation", [
      borrower.address,
      ethers.keccak256(ethers.toUtf8Bytes("DEPOSIT")),
      usdcAddr,
      amount,
      now,
    ]);

    try {
      await ethers.provider.call({ to: vaultRouterAddr, from: vaultCoreAddr, data });
      show("Step A", "OK");
    } catch (e: any) {
      const revertData = extractRevertData(e);
      show("Step A revertData", revertData);
      const parsed = revertData !== "0x" ? tryParseError(ifs, revertData) : null;
      show("Step A parsed", parsed ? { contract: parsed.name, error: parsed.parsed?.name, args: parsed.parsed?.args } : "<unparsed>");
      show("Step A msg", e.shortMessage ?? e.message);
    }
  }

  // Step B
  {
    show("\n[Step B] provider.call CollateralManager.depositCollateral (from VaultRouter)", "");
    const data = cm.interface.encodeFunctionData("depositCollateral", [borrower.address, usdcAddr, amount]);
    try {
      await ethers.provider.call({ to: cmAddr, from: vaultRouterAddr, data });
      show("Step B", "OK");
    } catch (e: any) {
      const revertData = extractRevertData(e);
      show("Step B revertData", revertData);
      const parsed = revertData !== "0x" ? tryParseError(ifs, revertData) : null;
      show("Step B parsed", parsed ? { contract: parsed.name, error: parsed.parsed?.name, args: parsed.parsed?.args } : "<unparsed>");
      show("Step B msg", e.shortMessage ?? e.message);
    }
  }

  // Extra
  {
    show("\n[Extra] verify VaultCore.viewContractAddrVar", "");
    try {
      const viewAddr = await vc.viewContractAddrVar();
      show("VaultCore.viewContractAddrVar()", viewAddr);
    } catch (e: any) {
      show("VaultCore.viewContractAddrVar() failed", e.shortMessage ?? e.message);
    }
  }

  // Step C
  {
    show("\n[Step C] VaultCore.deposit.staticCall (from borrower)", "");
    try {
      await vc.connect(borrower).deposit.staticCall(usdcAddr, amount);
      show("Step C", "OK");
    } catch (e: any) {
      const revertData = extractRevertData(e);
      show("Step C revertData", revertData);
      const parsed = revertData !== "0x" ? tryParseError(ifs, revertData) : null;
      show("Step C parsed", parsed ? { contract: parsed.name, error: parsed.parsed?.name, args: parsed.parsed?.args } : "<unparsed>");
      show("Step C msg", e.shortMessage ?? e.message);
    }
  }

  show("\nDone", { deployer: deployer.address, borrower: borrower.address });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
