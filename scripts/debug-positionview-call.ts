import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../frontend-config/contracts-localhost";

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

  try {
    await ethers.provider.call({ to: pvAddr, from: vrAddr, data });
    console.log("call ok");
  } catch (e: any) {
    const d = e.data ?? e.error?.data ?? e?.error?.error?.data;
    console.log("error msg", e.shortMessage ?? e.message);
    console.log("raw data", d);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
