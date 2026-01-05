import { task, types } from 'hardhat/config';
import { ethers as Ethers } from 'ethers';
import fs from 'fs';
import path from 'path';

type DeploymentMap = Record<string, string>;

function loadDeploymentsFile(network: string): DeploymentMap {
  const base = path.resolve(__dirname, '..', 'deployments');
  const file = network === 'localhost'
    ? path.join(base, 'localhost.json')
    : path.join(base, 'addresses.arbitrum-sepolia.json');
  if (!fs.existsSync(file)) throw new Error(`Deployments file not found: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as DeploymentMap;
}

function k256(upperSnake: string): string {
  return Ethers.keccak256(Ethers.toUtf8Bytes(upperSnake));
}

const KEYS = {
  VAULT_CORE: 'VaultCore',
  VAULT_VIEW: 'VaultRouter',
  REWARD_VIEW: 'RewardView',
  LENDING_ENGINE: 'LendingEngine',
} as const;

task('registry:sync', 'Batch sync module mappings from deployments to Registry')
  .addOptionalParam('networkName', 'Network name (localhost|arbitrum-sepolia)', 'localhost', types.string)
  .addOptionalParam('only', 'Comma-separated key names to limit, e.g. VAULT_CORE,VAULT_VIEW', undefined, types.string)
  .setAction(async (args) => {
    const { networkName, only } = args as { networkName: string; only?: string };

    const RPC_URL = process.env.RPC_URL || (networkName === 'localhost' ? 'http://127.0.0.1:8545' : process.env.ARBITRUM_SEPOLIA_URL);
    if (!RPC_URL) throw new Error('RPC_URL not set');
    const PRIVATE_KEY = process.env.PRIVATE_KEY;
    if (!PRIVATE_KEY) throw new Error('PRIVATE_KEY not set');

    const deployments = loadDeploymentsFile(networkName);

    const registryAddr = deployments.Registry || deployments.registry || deployments.REGISTRY;
    if (!registryAddr) throw new Error('Registry address not found in deployments');

    const provider = new Ethers.JsonRpcProvider(RPC_URL);
    const signer = new Ethers.Wallet(PRIVATE_KEY, provider);

    const REGISTRY_ABI = [
      'function getModule(bytes32) view returns (address)',
      'function setModule(bytes32,address) external',
    ];
    const registry = new Ethers.Contract(registryAddr, REGISTRY_ABI, signer);

    const names = (only ? only.split(',') : Object.keys(KEYS))
      .map((s) => s.trim())
      .filter(Boolean);

    for (const name of names) {
      const depName = (KEYS as Record<string, string>)[name];
      if (!depName) {
        console.warn(`[skip] unknown key name: ${name}`);
        continue;
      }

      const want = deployments[depName];
      if (!want || want === Ethers.ZeroAddress) {
        console.warn(`[skip] no desired address for ${name} (${depName}) in deployments file`);
        continue;
      }

      const key = k256(name);
      const current: string = await registry.getModule(key).catch(() => Ethers.ZeroAddress);
      if (current && current.toLowerCase() === want.toLowerCase()) {
        console.log(`[ok] ${name} already set: ${current}`);
        continue;
      }

      const tx = await registry.setModule(key, want);
      console.log(`[tx] setModule(${name}, ${want}) -> ${tx.hash}`);
      await tx.wait();
      console.log(`[done] ${name} updated`);
    }

    console.log('All done.');
  });


