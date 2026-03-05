import { readFileSync, existsSync } from 'fs';
import { Contract, Interface, JsonRpcProvider, getAddress, id } from 'ethers';

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') throw new Error(`Missing required env: ${name}`);
  return v.trim();
}

function parseAddressSet(raw?: string): Set<string> {
  if (!raw || raw.trim() === '') return new Set();
  return new Set(
    raw
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => getAddress(x))
  );
}

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL || process.env.LOCALHOST_RPC_URL || 'http://127.0.0.1:8545';
  const provider = new JsonRpcProvider(rpcUrl);

  let acmAddr = process.env.ACM_ADDRESS?.trim();
  if (!acmAddr || acmAddr === '') {
    const registryAddr = process.env.REGISTRY_ADDRESS?.trim();
    if (registryAddr && registryAddr !== '') {
      const registryIface = new Interface(['function getModuleOrRevert(bytes32) view returns (address)']);
      const registry = new Contract(getAddress(registryAddr), registryIface, provider);
      const key = id('ACCESS_CONTROL_MANAGER');
      acmAddr = await registry.getModuleOrRevert(key);
    } else if (existsSync('deployments/localhost.json')) {
      const snap = JSON.parse(readFileSync('deployments/localhost.json', 'utf8')) as Record<string, string>;
      acmAddr = snap.AccessControlManager;
    }
  }
  if (!acmAddr || acmAddr.trim() === '') {
    throw new Error('Missing required env: ACM_ADDRESS (or REGISTRY_ADDRESS/deployments/localhost.json fallback)');
  }
  acmAddr = getAddress(acmAddr);
  const role = id('ACTION_REWARD_CONFIG_EMERGENCY');
  const fromBlock = BigInt(process.env.FROM_BLOCK || '0');
  const toBlock = await provider.getBlockNumber();

  const acmIface = new Interface([
    'event RoleGranted(bytes32 indexed role,address indexed account,address grantedBy)',
    'event RoleRevoked(bytes32 indexed role,address indexed account,address revokedBy)',
    'function hasRole(bytes32 role,address caller) view returns (bool)',
  ]);
  const roleGrantedEvent = acmIface.getEvent('RoleGranted');
  const roleRevokedEvent = acmIface.getEvent('RoleRevoked');
  if (!roleGrantedEvent || !roleRevokedEvent) {
    throw new Error('RoleGranted/RoleRevoked event not found in interface');
  }
  const acm = new Contract(acmAddr, acmIface, provider);

  // Reconstruct current holders from role grant/revoke logs.
  const holderSet = new Set<string>();
  const roleTopic = role.toLowerCase();
  const grantedLogs = await provider.getLogs({
    address: acmAddr,
    fromBlock,
    toBlock,
    topics: [roleGrantedEvent.topicHash, roleTopic],
  });
  for (const log of grantedLogs) {
    const parsed = acmIface.parseLog(log);
    if (!parsed) continue;
    holderSet.add(getAddress(parsed.args.account as string));
  }
  const revokedLogs = await provider.getLogs({
    address: acmAddr,
    fromBlock,
    toBlock,
    topics: [roleRevokedEvent.topicHash, roleTopic],
  });
  for (const log of revokedLogs) {
    const parsed = acmIface.parseLog(log);
    if (!parsed) continue;
    holderSet.delete(getAddress(parsed.args.account as string));
  }

  // Optional explicit scan list (for pre-known critical accounts).
  const scanSet = parseAddressSet(process.env.BREAKGLASS_SCAN_ADDRESSES);
  for (const account of scanSet) {
    if (await acm.hasRole(role, account)) holderSet.add(account);
  }

  // Verify reconstructed holders with on-chain hasRole (safety against historical forks).
  const effectiveHolders: string[] = [];
  for (const account of holderSet) {
    if (await acm.hasRole(role, account)) effectiveHolders.push(account);
  }

  const allowlist = parseAddressSet(process.env.BREAKGLASS_ALLOWLIST);
  const unexpected = effectiveHolders.filter((a) => !allowlist.has(a));

  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected break-glass holders detected (${unexpected.length}):\n- ${unexpected.join('\n- ')}\n`
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    `check-reward-breakglass-holders: OK (holders=${effectiveHolders.length}, allowlist=${allowlist.size}, toBlock=${toBlock})`
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
