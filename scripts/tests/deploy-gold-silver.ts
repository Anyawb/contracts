import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost.ts";

async function main() {
  const [deployer] = await ethers.getSigners();
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const decimals = 18;
  const initialSupply = ethers.parseUnits("1000000000", decimals);

  const gold = await MockERC20.deploy("MockGold", "GOLD", decimals, initialSupply);
  await gold.waitForDeployment();
  const silver = await MockERC20.deploy("MockSilver", "SILV", decimals, initialSupply);
  await silver.waitForDeployment();

  const awRead = (await ethers.getContractAt("IAssetWhitelistRead", CONTRACT_ADDRESSES.AssetWhitelist)) as any;
  const awAdmin = (await ethers.getContractAt("IAssetWhitelistAdmin", CONTRACT_ADDRESSES.AssetWhitelist)) as any;
  const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", CONTRACT_ADDRESSES.PriceOracle)) as any;
  const feeRouter = (await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", CONTRACT_ADDRESSES.FeeRouter)) as any;
  const acm = await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager);

  const ensureRole = async (role: string, who: string) => {
    if (!(await acm.hasRole(role, who))) await (await acm.grantRole(role, who)).wait();
  };
  const key = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));

  await ensureRole(key("ADD_WHITELIST"), deployer.address);
  await ensureRole(key("UPDATE_PRICE"), deployer.address);
  await ensureRole(key("SET_PARAMETER"), deployer.address);

  const configureToken = async (tokenAddr: string, symbol: string, priceUsd: string) => {
    if (!(await awRead.isAssetAllowed(tokenAddr))) {
      await (await awAdmin.connect(deployer).addAllowedAsset(tokenAddr)).wait();
    }
    const cfg = await po.getAssetConfig(tokenAddr);
    if (!cfg.isActive) {
      await (await po.connect(deployer).configureAsset(tokenAddr, symbol.toLowerCase(), decimals, 3600)).wait();
    }
    const now = await ethers.provider.getBlockNumber();
    await (await po.connect(deployer).updatePrice(tokenAddr, ethers.parseUnits(priceUsd, decimals), now)).wait();
    if (!(await feeRouter.isTokenSupported(tokenAddr))) {
      await (await feeRouter.connect(deployer).addSupportedToken(tokenAddr)).wait();
    }
  };

  await configureToken(gold.target as string, "GOLD", "2000");
  await configureToken(silver.target as string, "SILV", "25");

  console.log(`GOLD token deployed: ${gold.target}`);
  console.log(`SILV token deployed: ${silver.target}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
