import { ethers, network } from "hardhat";
import { loadAddressMap, resolveAddress } from "./_addressResolver";

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

async function listRoleHolders(token: any, role: string): Promise<string[]> {
  const count = Number(await token.getRoleMemberCount(role));
  const holders: string[] = [];
  for (let i = 0; i < count; i++) {
    holders.push((await token.getRoleMember(role, i)) as string);
  }
  return holders;
}

async function main() {
  const addressMap = loadAddressMap(network.name);
  const registryAddr = resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });
  const registry = (await ethers.getContractAt("Registry", registryAddr)) as any;

  const acmAddr = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
  const easyTokenAddr = (await registry.getModuleOrRevert(key("EASY_TOKEN"))) as string;
  const emissionAddr = (await registry.getModule(key("EASY_EMISSION_CONTROLLER"))) as string;
  const recycleAddr = (await registry.getModule(key("EASY_RECYCLE_DISTRIBUTOR"))) as string;
  const rmCoreAddr = (await registry.getModule(key("REWARD_MANAGER_CORE"))) as string;
  const ramAddr = (await registry.getModule(key("REWARD_ACCRUAL_MANAGER"))) as string;

  const easyToken = (await ethers.getContractAt("src/Token/EasyToken.sol:EasyToken", easyTokenAddr)) as any;

  const MINTER_ROLE = await easyToken.MINTER_ROLE();
  const BURNER_ROLE = await easyToken.BURNER_ROLE();

  const minters = await listRoleHolders(easyToken, MINTER_ROLE);
  const burners = await listRoleHolders(easyToken, BURNER_ROLE);

  console.log("=== EasyToken Role Check ===");
  console.log(`network: ${network.name}`);
  console.log(`Registry: ${registryAddr}`);
  console.log(`ACM: ${acmAddr}`);
  console.log(`EasyToken: ${easyTokenAddr}`);
  console.log(`EasyEmissionController: ${emissionAddr || "<missing>"}`);
  console.log(`EasyRecycleDistributor: ${recycleAddr || "<missing>"}`);
  console.log(`RewardManagerCore: ${rmCoreAddr || "<missing>"}`);
  console.log(`RewardAccrualManager: ${ramAddr || "<missing>"}`);
  console.log("");

  console.log(`MINTER_ROLE holders (${minters.length}):`);
  for (const h of minters) console.log(`  - ${h}`);
  console.log("");

  console.log(`BURNER_ROLE holders (${burners.length}):`);
  for (const h of burners) console.log(`  - ${h}`);
  console.log("");

  const soleMinterOk = emissionAddr && emissionAddr !== ethers.ZeroAddress && minters.length === 1 &&
    minters[0].toLowerCase() === emissionAddr.toLowerCase();
  const burnerOk = [recycleAddr, ramAddr]
    .filter((v) => v && v !== ethers.ZeroAddress)
    .every((v) => burners.map((b) => b.toLowerCase()).includes((v as string).toLowerCase()));

  console.log(`Sole minter == EasyEmissionController: ${soleMinterOk ? "OK" : "NO"}`);
  console.log(`Burners include EasyRecycleDistributor + RewardAccrualManager: ${burnerOk ? "OK" : "NO"}`);
}

main().catch((e) => {
  console.error("\n❌ check-easy-roles-local FAILED\n");
  console.error(e);
  process.exitCode = 1;
});
