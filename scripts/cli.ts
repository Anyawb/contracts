#!/usr/bin/env ts-node

import { Command } from 'commander';
import 'dotenv/config';

const program = new Command();
program
  .name('contracts-cli')
  .description('Contracts CLI wrapper for Hardhat tasks')
  .version('1.0.0');

function runHardhat(taskWithArgs: string): void {
  // 动态导入 hardhat 的入口，确保使用本包 hardhat
  // 通过子进程更稳妥，但这里简化为 programmatic 方式：使用命令字符串交给 npx hardhat
  // 为避免跨平台差异，这里使用 child_process spawn 同步执行
}

// 由于多数任务已在 hardhat.config.ts 注册，这里直接通过 shell 代理更简单可靠
import { spawnSync } from 'child_process';
function hh(args: string[]): void {
  const res = spawnSync('npx', ['hardhat', ...args], { stdio: 'inherit', env: process.env });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

// registry:check
program
  .command('registry:check')
  .description('Read-only check of module mappings in Registry')
  .option('--networkName <name>', 'localhost|arbitrum-sepolia', 'localhost')
  .action((opts: { networkName: string }) => {
    hh(['registry:check', '--networkName', String(opts.networkName || 'localhost')]);
  });

// registry:set
program
  .command('registry:set')
  .description('Set a single module mapping in Registry')
  .requiredOption('--module <UPPER_SNAKE>', 'Module key, e.g. VAULT_VIEW')
  .requiredOption('--address <0x...>', 'Address to set')
  .option('--networkName <name>', 'localhost|arbitrum-sepolia', 'localhost')
  .action((opts: { module: string; address: string; networkName: string }) => {
    hh(['registry:set', '--module', opts.module, '--address', opts.address, '--networkName', String(opts.networkName || 'localhost')]);
  });

// registry:sync
program
  .command('registry:sync')
  .description('Batch sync module mappings from deployments file')
  .option('--only <CSV>', 'Only these keys, e.g. VAULT_CORE,VAULT_VIEW')
  .option('--networkName <name>', 'localhost|arbitrum-sepolia', 'localhost')
  .action((opts: { only?: string; networkName: string }) => {
    const args = ['registry:sync', '--networkName', String(opts.networkName || 'localhost')];
    if (opts.only) args.push('--only', opts.only);
    hh(args);
  });

// registry:verify:family（已有 hardhat 任务）
program
  .command('registry:verify:family')
  .description('Verify Registry family storage/layout and views')
  .option('--deployFile <path>', 'Deploy JSON', 'scripts/deployments/localhost.json')
  .action((opts: { deployFile: string }) => {
    hh(['registry:verify:family', '--deployFile', opts.deployFile]);
  });

// registry:migrate:min（已有 hardhat 任务）
program
  .command('registry:migrate:min')
  .description('Minimal governance-driven migration for Registry family')
  .requiredOption('--registry <address>', 'Proxy address of Registry')
  .option('--newImpl <address>', 'New implementation')
  .option('--newStorageVersion <num>', 'New storage version')
  .action((opts: { registry: string; newImpl?: string; newStorageVersion?: string }) => {
    const args = ['registry:migrate:min', '--registry', opts.registry];
    if (opts.newImpl) args.push('--newImpl', opts.newImpl);
    if (opts.newStorageVersion) args.push('--newStorageVersion', String(opts.newStorageVersion));
    hh(args);
  });

program.parseAsync(process.argv).catch((e) => { console.error(e); process.exit(1); });


