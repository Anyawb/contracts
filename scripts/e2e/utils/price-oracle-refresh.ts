import { ethers } from "hardhat";

export async function refreshPriceOracleBlock(params: {
  priceOracle: any;
  asset: string;
  signer: any;
  label?: string;
  print?: boolean;
}): Promise<void> {
  const now = BigInt(await ethers.provider.getBlockNumber());
  let price: bigint;
  try {
    const pd = await params.priceOracle.getPriceData(params.asset);
    price = BigInt((pd as any).price ?? (pd as any)[0]);
  } catch {
    const p = await params.priceOracle.getPrice(params.asset);
    price = BigInt((p as any).price ?? (p as any)[0]);
  }
  const tx = await params.priceOracle.connect(params.signer).updatePrice(params.asset, price, now);
  await tx.wait();
  if (params.print) {
    const label = params.label ?? "Refreshed PriceOracle blockNumber";
    console.log(`  ✅ ${label} for ${params.asset.slice(0, 10)} (price unchanged)`);
  }
}
