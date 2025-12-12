import { task, types } from 'hardhat/config';

// utils:deploy:contract
task('utils:deploy:contract', 'Deploy a single contract using deploymentUtils')
  .addParam('name', 'Contract name')
  .addOptionalParam('args', 'Constructor args as JSON array', '[]', types.string)
  .setAction(async (args, _hre) => {
    const { deployContract } = await import('../utils/deploymentUtils');
    const ctorArgs = JSON.parse(String(args.args || '[]')) as unknown[];
    await deployContract(String(args.name), ctorArgs, true);
  });

// utils:verify:contract
task('utils:verify:contract', 'Verify a contract on explorer via verificationUtils')
  .addParam('address', 'Contract address')
  .addOptionalParam('ctor', 'Constructor args as JSON array', '[]', types.string)
  .setAction(async (args, hre) => {
    const { verifyContract } = await import('../utils/verificationUtils');
    const ctorArgs = JSON.parse(String(args.ctor || '[]')) as unknown[];
    await verifyContract({ network: hre.network.name, contractAddress: String(args.address), constructorArgs: ctorArgs });
  });

// utils:module-keys (generate TS constants)
task('utils:module-keys', 'Generate frontend moduleKeys.ts from ModuleKeys definitions')
  .setAction(async () => {
    const { generateModuleKeysTS } = await import('../utils/generateModuleKeys');
    await generateModuleKeysTS();
  });


