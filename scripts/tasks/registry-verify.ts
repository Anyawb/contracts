import { task } from 'hardhat/config';
import fs from 'fs';

task('registry:verify:family', 'Verify Registry (Scheme A) storage/layout and basic views')
  .addOptionalParam('deployFile', 'Deployment JSON path', 'scripts/deployments/localhost.json')
  .setAction(async (args, hre) => {
    const { deployFile } = args as { deployFile: string };
    const { ethers } = hre;
    const [signer] = await ethers.getSigners();
    console.log('Verifier:', signer.address);

    const json = JSON.parse(fs.readFileSync(deployFile, 'utf8'));
    const regAddr: string = json['Registry']; 
    const dynKeyAddr: string | undefined = json['RegistryDynamicModuleKey'];

    // 1) Registry
    const Registry = await ethers.getContractAt('Registry', regAddr, signer);
    await Registry.validateStorageLayout();
    const regVer = await Registry.getStorageVersion();
    console.log('Registry.storageVersion:', regVer.toString());

    // 2) Optional: RegistryDynamicModuleKey (independent storage by design)
    if (dynKeyAddr) {
      try {
        const Dyn = await ethers.getContractAt('RegistryDynamicModuleKey', dynKeyAddr, signer);
        const regAdmin = await Dyn.getRegistrationAdmin();
        const sysAdmin = await Dyn.getSystemAdmin();
        console.log('RegistryDynamicModuleKey.registrationAdmin:', regAdmin);
        console.log('RegistryDynamicModuleKey.systemAdmin:', sysAdmin);
      } catch (e) {
        console.log('RegistryDynamicModuleKey check skipped/failed:', e);
      }
    }

    console.log('Registry (Scheme A) verification completed.');
  });


