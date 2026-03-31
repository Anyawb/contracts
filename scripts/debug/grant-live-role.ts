import { ethers, network } from "hardhat";

import { envStr, loadAddressMap, resolveAddress } from "../tests/_addressResolver";

async function main() {
  const roleRaw = envStr("DEBUG_ROLE_RAW")?.trim();
  const targetAccount = envStr("DEBUG_ROLE_ACCOUNT")?.trim();
  if (!roleRaw || !targetAccount) {
    throw new Error("set DEBUG_ROLE_RAW and DEBUG_ROLE_ACCOUNT");
  }

  const addressMap = loadAddressMap(network.name, { preferMockSuite: true });
  const registryAddr = resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });
  const registry = (await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    registryAddr,
  )) as any;
  const acmAddr = (await registry.getModuleOrRevert(ethers.keccak256(ethers.toUtf8Bytes("ACCESS_CONTROL_MANAGER")))) as string;
  const [signer] = await ethers.getSigners();
  const acm = (await ethers.getContractAt(
    [
      "function hasRole(bytes32,address) view returns (bool)",
      "function grantRole(bytes32,address)",
    ],
    acmAddr,
    signer,
  )) as any;

  const role = ethers.keccak256(ethers.toUtf8Bytes(roleRaw));
  const before = (await acm.hasRole(role, targetAccount)) as boolean;
  console.log(`Registry=${registryAddr}`);
  console.log(`AccessControlManager=${acmAddr}`);
  console.log(`Signer=${signer.address}`);
  console.log(`RoleRaw=${roleRaw}`);
  console.log(`Target=${targetAccount}`);
  console.log(`Before=${before}`);

  if (!before) {
    const tx = await acm.grantRole(role, targetAccount);
    console.log(`GrantTx=${tx.hash}`);
    await tx.wait();
  }

  const after = (await acm.hasRole(role, targetAccount)) as boolean;
  console.log(`After=${after}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});