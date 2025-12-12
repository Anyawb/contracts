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

// 可按需扩展：关键模块键集合
const KEYS: ReadonlyArray<string> = [
  'VAULT_CORE',
  'VAULT_VIEW',
  'REWARD_VIEW',
  'LENDING_ENGINE',
];

task('registry:check', 'Read-only check of module mappings in Registry')
  .addOptionalParam('networkName', 'Network name (localhost|arbitrum-sepolia)', 'localhost', types.string)
  .setAction(async (args) => {
    const { networkName } = args as { networkName: string };

    const deployments = loadDeploymentsFile(networkName);

    const RPC_URL = process.env.RPC_URL || (networkName === 'localhost' ? 'http://127.0.0.1:8545' : process.env.ARBITRUM_SEPOLIA_URL);
    if (!RPC_URL) throw new Error('RPC_URL not set');

    const provider = new Ethers.JsonRpcProvider(RPC_URL);

    const registryAddr = deployments.Registry || deployments.registry || deployments.REGISTRY;
    if (!registryAddr) throw new Error('Registry address not found in deployments');

    const REGISTRY_ABI = ['function getModule(bytes32) view returns (address)'];
    const registry = new Ethers.Contract(registryAddr, REGISTRY_ABI, provider);

    for (const name of KEYS) {
      const key = k256(name);
      const addr: string = await registry.getModule(key).catch(() => Ethers.ZeroAddress);
      console.log(name.padEnd(16), '=>', addr);
    }
  });


