import { Contract, Interface, JsonRpcProvider, getAddress, id } from 'ethers';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

type ExpectedBindings = Record<string, string>;

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') throw new Error(`Missing required env: ${name}`);
  return v.trim();
}

function loadExpectedBindings(): ExpectedBindings {
  const file = process.env.REWARD_CONFIG_BINDINGS_FILE?.trim();
  if (file) {
    const abs = join(process.cwd(), file);
    if (!existsSync(abs)) throw new Error(`Missing bindings file: ${file}`);
    return JSON.parse(readFileSync(abs, 'utf8')) as ExpectedBindings;
  }

  const buildExpectedFromSnapshot = (snap: Record<string, string>): ExpectedBindings => {
    const expected: ExpectedBindings = {};
    if (snap.RewardManager) expected.REWARD_MANAGER = snap.RewardManager;
    if (snap.RewardManagerCore) expected.REWARD_MANAGER_CORE = snap.RewardManagerCore;
    if (snap.RewardAccrualManager) expected.REWARD_ACCRUAL_MANAGER = snap.RewardAccrualManager;
    if (snap.RewardConfig) expected.REWARD_CONFIG = snap.RewardConfig;
    if (snap.EarnConfig) expected.REWARD_EARN_CONFIG = snap.EarnConfig;
    if (snap.FeatureRegistry) expected.FEATURE_REGISTRY = snap.FeatureRegistry;
    if (snap.GovernanceGate) expected.GOVERNANCE_GATE = snap.GovernanceGate;
    if (snap.RewardView) expected.REWARD_VIEW = snap.RewardView;
    if (snap.EasyToken) expected.EASY_TOKEN = snap.EasyToken;
    if (snap.EasyEmissionConfig) expected.EASY_EMISSION_CONFIG = snap.EasyEmissionConfig;
    if (snap.EasyEmissionController) expected.EASY_EMISSION_CONTROLLER = snap.EasyEmissionController;
    if (snap.EasyConsumption) expected.EASY_CONSUMPTION = snap.EasyConsumption;
    if (snap.EasyRecycleDistributor) expected.EASY_RECYCLE_DISTRIBUTOR = snap.EasyRecycleDistributor;
    if (snap.EasyStaking) expected.EASY_STAKING = snap.EasyStaking;
    return expected;
  };

  if (existsSync('scripts/deployments/localhost.json')) {
    const snap = JSON.parse(readFileSync('scripts/deployments/localhost.json', 'utf8')) as Record<string, string>;
    const expected = buildExpectedFromSnapshot(snap);
    if (Object.keys(expected).length > 0) return expected;
  }

  if (existsSync('deployments/localhost.json')) {
    const snap = JSON.parse(readFileSync('deployments/localhost.json', 'utf8')) as Record<string, string>;
    const expected = buildExpectedFromSnapshot(snap);
    if (Object.keys(expected).length > 0) return expected;
  }

  return {
    REWARD_MANAGER: getEnv('EXPECTED_REWARD_MANAGER'),
    REWARD_MANAGER_CORE: getEnv('EXPECTED_REWARD_MANAGER_CORE'),
    REWARD_ACCRUAL_MANAGER: getEnv('EXPECTED_REWARD_ACCRUAL_MANAGER'),
    REWARD_CONFIG: getEnv('EXPECTED_REWARD_CONFIG'),
    REWARD_EARN_CONFIG: getEnv('EXPECTED_REWARD_EARN_CONFIG'),
    FEATURE_REGISTRY: getEnv('EXPECTED_FEATURE_REGISTRY'),
    GOVERNANCE_GATE: getEnv('EXPECTED_GOVERNANCE_GATE'),
    REWARD_VIEW: getEnv('EXPECTED_REWARD_VIEW'),
    EASY_TOKEN: getEnv('EXPECTED_EASY_TOKEN'),
    EASY_EMISSION_CONFIG: getEnv('EXPECTED_EASY_EMISSION_CONFIG'),
    EASY_EMISSION_CONTROLLER: getEnv('EXPECTED_EASY_EMISSION_CONTROLLER'),
    EASY_CONSUMPTION: getEnv('EXPECTED_EASY_CONSUMPTION'),
    EASY_RECYCLE_DISTRIBUTOR: getEnv('EXPECTED_EASY_RECYCLE_DISTRIBUTOR'),
    EASY_STAKING: getEnv('EXPECTED_EASY_STAKING'),
  };
}

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL || process.env.LOCALHOST_RPC_URL || 'http://127.0.0.1:8545';
  const provider = new JsonRpcProvider(rpcUrl);
  let registryAddress = process.env.REGISTRY_ADDRESS?.trim();
  if (!registryAddress || registryAddress === '') {
    const snapshotCandidates = ['scripts/deployments/localhost.json', 'deployments/localhost.json'];
    for (const file of snapshotCandidates) {
      if (!existsSync(file)) continue;
      const snap = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
      if (snap.Registry) {
        registryAddress = snap.Registry;
        break;
      }
    }
  }
  if (!registryAddress || registryAddress.trim() === '') {
    throw new Error('Missing required env: REGISTRY_ADDRESS (or deployments/localhost.json fallback)');
  }
  registryAddress = getAddress(registryAddress);

  const registryCode = await provider.getCode(registryAddress);
  if (!registryCode || registryCode === '0x') {
    // eslint-disable-next-line no-console
    console.log(`check-reward-registry-bindings: SKIP (no code at ${registryAddress})`);
    return;
  }

  const registry = new Contract(
    registryAddress,
    new Interface(['function getModuleOrRevert(bytes32) view returns (address)']),
    provider
  );

  const expected = loadExpectedBindings();
  const failures: string[] = [];

  for (const [keyName, expectedAddrRaw] of Object.entries(expected)) {
    const moduleKey = id(keyName);
    const actual = getAddress(await registry.getModuleOrRevert(moduleKey));
    const expectedAddr = getAddress(expectedAddrRaw);

    if (actual !== expectedAddr) {
      failures.push(`${keyName}: expected=${expectedAddr} actual=${actual}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Reward registry binding drift detected (${failures.length}):\n- ${failures.join('\n- ')}\n`);
  }

  // eslint-disable-next-line no-console
  console.log('check-reward-registry-bindings: OK');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
