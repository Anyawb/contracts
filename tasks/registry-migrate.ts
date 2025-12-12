import { task, types } from "hardhat/config";

task("registry:migrate:min", "Minimal governance-driven migration for Registry family")
  .addParam("registry", "Proxy address of Registry")
  .addOptionalParam("newImpl", "New implementation address for Registry (UUPS)")
  .addOptionalParam("newStorageVersion", "New storage version number", undefined, types.int)
  .setAction(async (args, hre) => {
    const { registry, newImpl, newStorageVersion } = args as {
      registry: string;
      newImpl?: string;
      newStorageVersion?: number;
    };

    const { ethers } = hre;
    const [signer] = await hre.ethers.getSigners();
    console.log("Executor:", signer.address);
    const Registry = await hre.ethers.getContractAt("Registry", registry, signer);

    if (newImpl && newImpl !== ethers.ZeroAddress) {
      console.log("Upgrading implementation via UUPS to:", newImpl);
      const tx = await Registry.upgradeTo(newImpl);
      await tx.wait();
      console.log("UUPS upgrade executed");
    }

    {
      console.log("Validating storage layout...");
      await Registry.validateStorageLayout();
      console.log("Storage layout validated (static)");
      const version = await Registry.getStorageVersion();
      console.log("Current storageVersion:", version.toString());
    }

    if (newStorageVersion !== undefined) {
      console.log("Upgrading storage version to:", newStorageVersion);
      const tx = await Registry.upgradeStorageVersion(newStorageVersion);
      await tx.wait();
      console.log("Storage version upgraded");
    }

    {
      console.log("Re-validating storage layout after actions...");
      await Registry.validateStorageLayout();
      console.log("Storage layout re-validated (static)");
      const version = await Registry.getStorageVersion();
      console.log("Final storageVersion:", version.toString());
    }

    console.log("Minimal migration done.");
  });


