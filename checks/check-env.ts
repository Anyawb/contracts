#!/usr/bin/env ts-node

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import logger from '../utils/logger';

// 必需的环境变量列表
const REQUIRED_VARS = [
  'PRIVATE_KEY'
];

// 可选但建议配置的环境变量
const RECOMMENDED_VARS = [
  'REPORT_GAS',
  'ETHERSCAN_API_KEY',
  'ARBISCAN_API_KEY'
];

// 网络特定的环境变量
const NETWORK_VARS: Record<string, string[]> = {
  'arbitrum': ['ARBITRUM_RPC_URL'],
  'arbitrum-sepolia': ['ARBITRUM_SEPOLIA_RPC_URL'],
  'optimism': ['OPTIMISM_RPC_URL'],
  'optimism-sepolia': ['OPTIMISM_SEPOLIA_RPC_URL']
};

async function checkEnvVars(): Promise<void> {
  logger.info('检查环境变量配置...');
  const envPath = path.resolve(process.cwd(), '.env');
  let envVars: Record<string, string | undefined> = {};

  if (fs.existsSync(envPath)) {
    logger.info(`从 ${envPath} 加载环境变量`);
    envVars = dotenv.parse(fs.readFileSync(envPath));
  } else {
    logger.warning('未找到 .env 文件，仅检查系统环境变量');
  }

  envVars = { ...envVars, ...process.env } as Record<string, string>;

  let missingRequired = false;
  for (const varName of REQUIRED_VARS) {
    if (!envVars[varName]) {
      logger.error(`缺少必需的环境变量: ${varName}`);
      missingRequired = true;
    } else {
      logger.success(`✓ ${varName}`);
    }
  }

  for (const varName of RECOMMENDED_VARS) {
    if (!envVars[varName]) {
      logger.warning(`建议配置环境变量: ${varName}`);
    } else {
      logger.success(`✓ ${varName}`);
    }
  }

  logger.info('检查网络特定的环境变量:');
  for (const [network, vars] of Object.entries(NETWORK_VARS)) {
    let ok = true;
    for (const v of vars) {
      if (!envVars[v]) {
        logger.warning(`${network} 网络缺少环境变量: ${v}`);
        ok = false;
      }
    }
    if (ok) logger.success(`✓ ${network} 网络配置完整`);
  }

  if (envVars.PRIVATE_KEY) {
    const pk = String(envVars.PRIVATE_KEY);
    if (!pk.startsWith('0x') || pk.length !== 66) {
      logger.warning('PRIVATE_KEY 格式可能不正确，应为 0x 开头的 64 位十六进制字符串');
    }
  }

  if (missingRequired) {
    logger.error('环境变量检查失败，请配置所有必需的环境变量');
    process.exitCode = 1;
  } else {
    logger.success('环境变量检查通过！');
  }
}

if (require.main === module) {
  checkEnvVars().catch((e) => {
    logger.error('环境变量检查过程中出错', e as Error);
    process.exitCode = 1;
  });
}

export { checkEnvVars };


