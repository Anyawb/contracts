import type { Contract } from "ethers";

export type DeployMap = Record<string, string>;

export type DeployProxyFn = (name: string, args?: unknown[], opts?: Record<string, unknown>) => Promise<string>;

export type RegistryDeployConfig = {
  /** Minimum delay in seconds for timelocked operations */
  minDelaySeconds: number;
  /** Final governance owner (Timelock/Multisig) */
  initialOwner: string;
  /** Optional upgrade admin (extra upgrader; Registry keeps owner as ultimate authority) */
  upgradeAdmin: string;
  /** Emergency admin (pause/cancel emergency paths) */
  emergencyAdmin: string;
  /** Deployer EOA for optional legacy module ownership defaults */
  deployerAddress: string;

  /**
   * Whether to deploy legacy/compat “Registry family” modules.
   * NOTE (Scheme A):
   * - Current `Registry.sol` already contains the core logic and canonical state (RegistryStorage) behind ONE proxy.
   * - Deploying these legacy modules as separate proxies will NOT share state with the Registry proxy.
   *   Keep this OFF by default; enable only for old-script compatibility/testing.
   */
  deployCompatModules?: boolean;
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
      config.minDelaySeconds,
      config.upgradeAdmin,
      config.emergencyAdmin,
      config.initialOwner,
    ]);
    save(deployed);
  }

  const registry = await ethers.getContractAt("Registry", deployed.Registry);

  // Optional legacy/compat modules (kept for backwards compatibility / testing).
  if (config.deployCompatModules) {
    if (!deployed.RegistryCore) {
      deployed.RegistryCore = await deployProxy("RegistryCore", [deployed.Registry, config.minDelaySeconds]);
      save(deployed);
      await (await registry.setRegistryCore(deployed.RegistryCore)).wait();
      console.log("🔗 RegistryCore linked to Registry");
    }

    if (!deployed.RegistryUpgradeManager) {
      deployed.RegistryUpgradeManager = await deployProxy("RegistryUpgradeManager", [deployed.Registry, config.initialOwner]);
      save(deployed);
      try {
        await (await registry.setUpgradeManager(deployed.RegistryUpgradeManager)).wait();
        console.log("🔗 RegistryUpgradeManager linked");
      } catch (error) {
        console.log("⚠️ RegistryUpgradeManager linking failed:", error);
      }
    }

    if (!deployed.RegistryAdmin) {
      deployed.RegistryAdmin = await deployProxy("RegistryAdmin", [config.initialOwner]);
      save(deployed);
      try {
        await (await registry.setRegistryAdmin(deployed.RegistryAdmin)).wait();
        console.log("🔗 RegistryAdmin linked");
      } catch (error) {
        console.log("⚠️ RegistryAdmin linking failed:", error);
      }
    }
  }

  // Dynamic module key registry (optional)
  if (config.deployDynamicModuleKeyRegistry) {
    if (!deployed.RegistryDynamicModuleKey) {
      deployed.RegistryDynamicModuleKey = await deployProxy("RegistryDynamicModuleKey", [
        config.deployerAddress, // registrationAdmin (can be replaced post-deploy)
        config.deployerAddress, // systemAdmin
        config.initialOwner, // owner (OwnableUpgradeable)
      ]);
      save(deployed);
      console.log("✅ RegistryDynamicModuleKey deployed @", deployed.RegistryDynamicModuleKey);
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

