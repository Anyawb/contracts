import { task } from 'hardhat/config';
import fs from 'fs';

task('registry:verify:family', 'Verify Registry family storage/layout and basic views')
  .addOptionalParam('deployFile', 'Deployment JSON path', 'scripts/deployments/localhost.json')
  .setAction(async (args, hre) => {
    const { deployFile } = args as { deployFile: string };
    const { ethers } = hre;
    const [signer] = await ethers.getSigners();
    console.log('Verifier:', signer.address);

    const json = JSON.parse(fs.readFileSync(deployFile, 'utf8'));
    const regAddr: string = json['Registry']; 
    const coreAddr: string = json['RegistryCore']; 
    const upgMgrAddr: string | undefined = json['RegistryUpgradeManager']; 
    const adminAddr: string | undefined = json['RegistryAdmin']; 
    const batchMgrAddr: string | undefined = json['RegistryBatchManager']; 
    const histMgrAddr: string | undefined = json['RegistryHistoryManager']; 
    const sigMgrAddr: string | undefined = json['RegistrySignatureManager']; 

    // 1) Registry
    const Registry = await ethers.getContractAt('Registry', regAddr, signer);
    await Registry.validateStorageLayout();
    const regVer = await Registry.getStorageVersion();
    console.log('Registry.storageVersion:', regVer.toString());

    // 2) RegistryCore
    const RegistryCore = await ethers.getContractAt('RegistryCore', coreAddr, signer);
    // RegistryCore 当前版本不一定暴露 validateStorageLayout()（不同版本兼容）
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      await (RegistryCore as any).validateStorageLayout();
      console.log('RegistryCore.storage layout validated');
    } catch {
      console.log('RegistryCore.validateStorageLayout() not available, skipped');
    }
    const coreVer = await RegistryCore.getStorageVersion();
    console.log('RegistryCore.storageVersion:', coreVer.toString());

    // 3) RegistryUpgradeManager (if present)
    if (upgMgrAddr) {
      const UpgradeMgr = await ethers.getContractAt('RegistryUpgradeManager', upgMgrAddr, signer);
      const dummyKey = ethers.id('DUMMY');
      const info = await UpgradeMgr.getPendingUpgrade(dummyKey);
      console.log('UpgradeManager.getPendingUpgrade(dummy)', info);
      const ready = await UpgradeMgr.isUpgradeReady(dummyKey);
      console.log('UpgradeManager.isUpgradeReady(dummy)', ready);
    }

    // 4) RegistryAdmin (if present)
    if (adminAddr) {
      const RegAdmin = await ethers.getContractAt('RegistryAdmin', adminAddr, signer);
      const paused = await RegAdmin.isPaused();
      const maxDelay = await RegAdmin.getMaxDelay();
      console.log('RegistryAdmin.isPaused:', paused, 'maxDelay:', maxDelay.toString());
    }

    // 5) Optional managers
    if (batchMgrAddr) {
      const BatchMgr = await ethers.getContractAt('RegistryBatchManager', batchMgrAddr, signer);
      const owner = await BatchMgr.owner();
      console.log('RegistryBatchManager.owner:', owner);
    }
    if (histMgrAddr) {
      const HistMgr = await ethers.getContractAt('RegistryHistoryManager', histMgrAddr, signer);
      const dummyKey = ethers.id('DUMMY');
      const count = await HistMgr.getUpgradeHistoryCount(dummyKey);
      console.log('RegistryHistoryManager.getUpgradeHistoryCount(dummy):', count.toString());
    }
    if (sigMgrAddr) {
      const SigMgr = await ethers.getContractAt('RegistrySignatureManager', sigMgrAddr, signer);
      const nonces = await SigMgr.nonces(signer.address);
      console.log('RegistrySignatureManager.nonces(signer):', nonces.toString());
    }

    console.log('Registry family verification completed.');
  });


