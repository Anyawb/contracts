import type { Contract } from "ethers";

export type DeployMap = Record<string, string>;

export type DeployProxyFn = (name: string, args?: unknown[], opts?: Record<string, unknown>) => Promise<string>;

export type RegistryDeployConfig = {
  /** Minimum delay in blocks for timelocked operations */
  minDelayBlocks: number;
  /** Maximum delay cap in blocks (Registry policy) */
  maxDelayBlocks: number;
  /** Final governance owner (Timelock/Multisig) */
  initialOwner: string;
  /** Optional upgrade admin (extra upgrader; Registry keeps owner as ultimate authority) */
  upgradeAdmin: string;
  /** Emergency admin (pause/cancel emergency paths) */
  emergencyAdmin: string;
  /** Deployer EOA for optional legacy module ownership defaults */
  deployerAddress: string;

  /** Whether to deploy and set dynamic module key registry */
  deployDynamicModuleKeyRegistry?: boolean;
};

export async function deployRegistryStack(args: {
  ethers: any;
  deployed: DeployMap;
  save: (m: DeployMap) => void;
  deployProxy: DeployProxyFn;
  config: RegistryDeployConfig;
}): Promise<{
  registry: Contract;
  registryAddress: string;
}> {
  const { ethers, deployed, save, deployProxy, config } = args;

  if (!deployed.Registry) {
    deployed.Registry = await deployProxy("Registry", [
      config.minDelayBlocks,
      config.maxDelayBlocks,
      config.upgradeAdmin,
      config.emergencyAdmin,
      config.initialOwner,
    ]);
    save(deployed);
  }

  const registry = await ethers.getContractAt("Registry", deployed.Registry);

  // Dynamic module key registry (optional)
  if (config.deployDynamicModuleKeyRegistry) {
    if (!deployed.RegistryDynamicModuleKey) {
      deployed.RegistryDynamicModuleKey = await deployProxy("RegistryDynamicModuleKey", [
        config.deployerAddress, // registrationAdmin (can be replaced post-deploy)
        config.deployerAddress, // systemAdmin
        config.initialOwner, // owner (OwnableUpgradeable)
      ]);
      save(deployed);
      // NOTE: deployProxy already prints the deployed address; keep this log semantically distinct.
      console.log("✅ RegistryDynamicModuleKey ready");
    }

    try {
      await (await registry.setDynamicModuleKeyRegistry(deployed.RegistryDynamicModuleKey)).wait();
      console.log("✅ Dynamic module key registry set in Registry");
    } catch (error) {
      console.log("⚠️ Failed to set dynamic module key registry:", error);
    }
  }

  return { registry, registryAddress: deployed.Registry };
}

