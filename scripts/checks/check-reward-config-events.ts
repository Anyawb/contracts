import { readFileSync, existsSync } from 'fs';
import { JsonRpcProvider, Interface, id } from 'ethers';

type Failure = { module: string; event: string; details: string };

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') throw new Error(`Missing required env: ${name}`);
  return v.trim();
}

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL || process.env.LOCALHOST_RPC_URL || 'http://127.0.0.1:8545';
  const provider = new JsonRpcProvider(rpcUrl);
  const fromBlock = BigInt(process.env.FROM_BLOCK || '0');
  const toBlock = await provider.getBlockNumber();

  const cfgIface = new Interface([
    'event EarnConfigUpdated(bytes32 indexed kind,uint256 v0,uint256 v1,uint256 blockNumber)',
  ]);
  const earnCfgEvent = cfgIface.getEvent('EarnConfigUpdated');
  if (!earnCfgEvent) {
    throw new Error('EarnConfigUpdated event not found in interface');
  }

  const registryAddr = process.env.REGISTRY_ADDRESS?.trim();
  let modules: string[] = [];

  if (registryAddr) {
    const registryIface = new Interface(['function getModuleOrRevert(bytes32) view returns (address)']);
    const registry = new (await import('ethers')).Contract(registryAddr, registryIface, provider);
    const key = id('REWARD_CONFIG');
    const addr = await registry.getModuleOrRevert(key);
    modules.push(addr);
  } else {
    const single = process.env.REWARD_CONFIG_ADDRESS?.trim();
    if (single && single !== '') {
      modules = [single];
    } else {
      const raw = process.env.REWARD_CONFIG_MODULES?.trim();
      if (raw && raw !== '') {
        modules = raw.split(',').map((x) => x.trim()).filter(Boolean);
      } else if (existsSync('deployments/localhost.json')) {
        const snap = JSON.parse(readFileSync('deployments/localhost.json', 'utf8')) as Record<string, string>;
        if (snap.RewardConfig) modules = [snap.RewardConfig];
      }
      if (modules.length === 0) {
        throw new Error('Missing required env: REGISTRY_ADDRESS or REWARD_CONFIG_ADDRESS or REWARD_CONFIG_MODULES');
      }
    }
  }

  const failures: Failure[] = [];

  for (const moduleAddr of modules) {
    const configLogs = await provider.getLogs({
      address: moduleAddr,
      fromBlock,
      toBlock,
      topics: [earnCfgEvent.topicHash],
    });
    for (const log of configLogs) {
      const parsed = cfgIface.parseLog(log);
      if (!parsed) continue;
      const emittedBlock = parsed.args.blockNumber as bigint;
      if (emittedBlock !== BigInt(log.blockNumber)) {
        failures.push({
          module: moduleAddr,
          event: 'EarnConfigUpdated',
          details: `blockNumber=${emittedBlock} logBlock=${log.blockNumber}`,
        });
      }
    }
  }

  if (failures.length > 0) {
    const lines = failures.map((f, i) => `${i + 1}. ${f.module} ${f.event}: ${f.details}`);
    throw new Error(`Reward config event monitor failed (${failures.length}):\n${lines.join('\n')}\n`);
  }

  // eslint-disable-next-line no-console
  console.log(`check-reward-config-events: OK (modules=${modules.length}, toBlock=${toBlock})`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
