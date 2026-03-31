import { Contract, Interface, JsonRpcProvider, getAddress, id } from 'ethers';
import { existsSync, readFileSync } from 'fs';

type Snapshot = Record<string, string>;

type ExpectedRoleBindings = {
  easyToken: string;
  easyEmissionController: string;
  rewardAccrualManager: string;
  easyRecycleDistributor: string;
  rewardManagerCore?: string;
};

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') throw new Error(`Missing required env: ${name}`);
  return v.trim();
}

function loadSnapshot(): Snapshot | undefined {
  const candidates = ['scripts/deployments/localhost.json', 'deployments/localhost.json'];
  for (const file of candidates) {
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, 'utf8')) as Snapshot;
    }
  }
  return undefined;
}

function loadExpected(): ExpectedRoleBindings {
  const snap = loadSnapshot();
  if (snap?.EasyToken && snap?.EasyEmissionController && snap?.RewardAccrualManager && snap?.EasyRecycleDistributor) {
    return {
      easyToken: snap.EasyToken,
      easyEmissionController: snap.EasyEmissionController,
      rewardAccrualManager: snap.RewardAccrualManager,
      easyRecycleDistributor: snap.EasyRecycleDistributor,
      rewardManagerCore: snap.RewardManagerCore,
    };
  }

  return {
    easyToken: getEnv('EXPECTED_EASY_TOKEN'),
    easyEmissionController: getEnv('EXPECTED_EASY_EMISSION_CONTROLLER'),
    rewardAccrualManager: getEnv('EXPECTED_REWARD_ACCRUAL_MANAGER'),
    easyRecycleDistributor: getEnv('EXPECTED_EASY_RECYCLE_DISTRIBUTOR'),
    rewardManagerCore: process.env.EXPECTED_REWARD_MANAGER_CORE?.trim(),
  };
}

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL || process.env.LOCALHOST_RPC_URL || 'http://127.0.0.1:8545';
  const provider = new JsonRpcProvider(rpcUrl);
  const expected = loadExpected();

  const easyTokenAddr = getAddress(expected.easyToken);
  const easyTokenCode = await provider.getCode(easyTokenAddr);
  if (!easyTokenCode || easyTokenCode === '0x') {
    console.log(`check-reward-role-bindings: SKIP (no code at ${easyTokenAddr})`);
    return;
  }

  const easyToken = new Contract(
    easyTokenAddr,
    new Interface([
      'function MINTER_ROLE() view returns (bytes32)',
      'function BURNER_ROLE() view returns (bytes32)',
      'function hasRole(bytes32 role,address account) view returns (bool)',
    ]),
    provider
  );

  const minterRole = await easyToken.MINTER_ROLE();
  const burnerRole = await easyToken.BURNER_ROLE();

  const controller = getAddress(expected.easyEmissionController);
  const ram = getAddress(expected.rewardAccrualManager);
  const recycle = getAddress(expected.easyRecycleDistributor);
  const rmc = expected.rewardManagerCore ? getAddress(expected.rewardManagerCore) : undefined;

  const failures: string[] = [];

  if (!(await easyToken.hasRole(minterRole, controller))) {
    failures.push(`EASY_EMISSION_CONTROLLER missing MINTER_ROLE: ${controller}`);
  }
  if (!(await easyToken.hasRole(burnerRole, ram))) {
    failures.push(`REWARD_ACCRUAL_MANAGER missing BURNER_ROLE: ${ram}`);
  }
  if (!(await easyToken.hasRole(burnerRole, recycle))) {
    failures.push(`EASY_RECYCLE_DISTRIBUTOR missing BURNER_ROLE: ${recycle}`);
  }
  if (await easyToken.hasRole(burnerRole, controller)) {
    failures.push(`EASY_EMISSION_CONTROLLER must not hold BURNER_ROLE: ${controller}`);
  }
  if (await easyToken.hasRole(minterRole, ram)) {
    failures.push(`REWARD_ACCRUAL_MANAGER must not hold MINTER_ROLE: ${ram}`);
  }
  if (await easyToken.hasRole(minterRole, recycle)) {
    failures.push(`EASY_RECYCLE_DISTRIBUTOR must not hold MINTER_ROLE: ${recycle}`);
  }
  if (rmc && (await easyToken.hasRole(burnerRole, rmc))) {
    failures.push(`REWARD_MANAGER_CORE must not hold legacy BURNER_ROLE: ${rmc}`);
  }

  if (failures.length > 0) {
    throw new Error(`Reward role binding drift detected (${failures.length}):\n- ${failures.join('\n- ')}\n`);
  }

  console.log('check-reward-role-bindings: OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
