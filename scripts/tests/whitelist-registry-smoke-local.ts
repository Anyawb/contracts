import { ethers, network } from "hardhat";
import { envBool, loadAddressMap, resolveAddress } from "./_addressResolver";

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function fmtErr(e: any) {
  return e?.shortMessage ?? e?.message ?? String(e);
}

function assertOk(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  const readOnly = envBool("READ_ONLY", false);
  const enableWrite = envBool("ENABLE_WRITE", true);
  const addressMap = loadAddressMap(network.name);
  const registryAddr = resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });
  const probe = ethers.Wallet.createRandom().address;

  const whitelistRegistryAddr = resolveAddress({
    name: "WhitelistRegistry",
    map: addressMap,
    envVar: "WHITELIST_REGISTRY_ADDRESS",
  });
  const acmAddr = resolveAddress({
    name: "AccessControlManager",
    map: addressMap,
    envVar: "ACCESS_CONTROL_MANAGER_ADDRESS",
    required: false,
  });

  const provider = ethers.provider;
  const registryCode = await provider.getCode(registryAddr);
  const whitelistCode = await provider.getCode(whitelistRegistryAddr);
  assertOk(registryCode !== "0x", "Registry address has no deployed code");
  assertOk(whitelistCode !== "0x", "WhitelistRegistry address has no deployed code");

  const whitelistRegistry = (await ethers.getContractAt("WhitelistRegistry", whitelistRegistryAddr)) as any;

  if (readOnly || !enableWrite) {
    const storedRegistryAddr = (await whitelistRegistry.getRegistry()) as string;
    assertOk(
      storedRegistryAddr.toLowerCase() === registryAddr.toLowerCase(),
      `WhitelistRegistry registry mismatch: expected ${registryAddr}, got ${storedRegistryAddr}`
    );

    const before = await whitelistRegistry.isWhitelisted(probe);
    assertOk(before === false, "Random probe address should not be whitelisted");

    if (acmAddr) {
      const acmCode = await provider.getCode(acmAddr);
      assertOk(acmCode !== "0x", "AccessControlManager address has no deployed code");
    }

    console.log("\n✅ WhitelistRegistry read-only smoke PASSED");
    console.log(`Registry: ${registryAddr}`);
    console.log(`WhitelistRegistry: ${whitelistRegistryAddr}`);
    if (acmAddr) console.log(`AccessControlManager: ${acmAddr}`);
    console.log(`Probe: ${probe}`);
    return;
  }

  const [deployer] = await ethers.getSigners();
  const reg = (await ethers.getContractAt("Registry", registryAddr)) as any;
  const resolvedWhitelistRegistryAddr = (await reg.getModuleOrRevert(key("WHITELIST_REGISTRY"))) as string;
  assertOk(
    resolvedWhitelistRegistryAddr.toLowerCase() === whitelistRegistryAddr.toLowerCase(),
    `WhitelistRegistry mismatch: expected ${whitelistRegistryAddr}, got ${resolvedWhitelistRegistryAddr}`
  );

  const resolvedAcmAddr = (await reg.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
  assertOk(
    !acmAddr || resolvedAcmAddr.toLowerCase() === acmAddr.toLowerCase(),
    `AccessControlManager mismatch: expected ${acmAddr}, got ${resolvedAcmAddr}`
  );

  const acm = (await ethers.getContractAt("AccessControlManager", resolvedAcmAddr)) as any;
  const addRole = key("ADD_WHITELIST");
  const removeRole = key("REMOVE_WHITELIST");
  const requireAuthz = envBool("REQUIRE_AUTHZ", true);

  const hasAddRole = await acm.hasRole(addRole, deployer.address);
  const hasRemoveRole = await acm.hasRole(removeRole, deployer.address);
  if (requireAuthz) {
    assertOk(hasAddRole, "Deployer is missing ADD_WHITELIST role");
    assertOk(hasRemoveRole, "Deployer is missing REMOVE_WHITELIST role");
  }

  const before = await whitelistRegistry.isWhitelisted(probe);
  assertOk(before === false, "Probe address should start as not whitelisted");

  const addTx = await whitelistRegistry.connect(deployer).addAddress(probe);
  await addTx.wait();

  const afterAdd = await whitelistRegistry.isWhitelisted(probe);
  assertOk(afterAdd === true, "Probe address should be whitelisted after addAddress");

  const removeTx = await whitelistRegistry.connect(deployer).removeAddress(probe);
  await removeTx.wait();

  const afterRemove = await whitelistRegistry.isWhitelisted(probe);
  assertOk(afterRemove === false, "Probe address should be removed after removeAddress");

  console.log("\n✅ WhitelistRegistry smoke PASSED");
  console.log(`Registry: ${registryAddr}`);
  console.log(`WhitelistRegistry: ${whitelistRegistryAddr}`);
  console.log(`Probe: ${probe}`);
}

main().catch((e) => {
  console.error(fmtErr(e));
  process.exitCode = 1;
});