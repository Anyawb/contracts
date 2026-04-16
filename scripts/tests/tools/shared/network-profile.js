const { spawnSync } = require('child_process');

function parseExports(stdout) {
  const env = {};
  for (const line of String(stdout || '').split('\n')) {
    const match = line.match(/^export\s+([A-Z0-9_]+)=(.*)$/);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    try {
      env[key] = JSON.parse(rawValue);
    } catch {
      env[key] = rawValue;
    }
  }
  return env;
}

function loadNetworkProfile(network = process.env.LIVE_TEST_NETWORK) {
  if (!network || !String(network).trim()) {
    throw new Error('LIVE_TEST_NETWORK is required to resolve a live-test profile');
  }

  const result = spawnSync(
    'pnpm',
    [
      '-s',
      'ts-node',
      '--project',
      './tsconfig.scripts.json',
      'scripts/tests/tools/shared/network-profile.ts',
      'env',
      '--network',
      network,
    ],
    {
      encoding: 'utf8',
      cwd: process.cwd(),
      env: process.env,
    },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `Failed to resolve network profile for ${network}`);
  }

  return parseExports(result.stdout);
}

module.exports = {
  loadNetworkProfile,
};
