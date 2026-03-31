#!/usr/bin/env ts-node

import logger from '../utils/logger';

if (!process.env.HARDHAT_NETWORK && process.env.LOCALHOST_RPC_URL) {
  process.env.HARDHAT_NETWORK = 'localhost';
}

const BASELINE_ROLES = [
  ['ACTION_ADMIN', 'ACTION_ADMIN'],
  ['ACTION_SET_PARAMETER', 'SET_PARAMETER'],
  ['ACTION_UPGRADE_MODULE', 'UPGRADE_MODULE'],
  ['ACTION_PAUSE_SYSTEM', 'PAUSE_SYSTEM'],
  ['ACTION_UNPAUSE_SYSTEM', 'UNPAUSE_SYSTEM'],
];

const OBSERVER_ROLES = [
  ['ACTION_VIEW_SYSTEM_DATA', 'VIEW_SYSTEM_DATA'],
  ['ACTION_VIEW_USER_DATA', 'VIEW_USER_DATA'],
  ['ACTION_VIEW_PRICE_DATA', 'VIEW_PRICE_DATA'],
  ['ACTION_VIEW_RISK_DATA', 'VIEW_RISK_DATA'],
  ['ACTION_VIEW_LIQUIDATION_DATA', 'VIEW_LIQUIDATION_DATA'],
  ['ACTION_VIEW_PUSH', 'ACTION_VIEW_PUSH'],
];

function roleHash(
  ethersLike: { keccak256: (data: Uint8Array | string) => string; toUtf8Bytes: (text: string) => Uint8Array },
  roleName: string,
): string {
  return ethersLike.keccak256(ethersLike.toUtf8Bytes(roleName));
}

async function checkRoles(): Promise<void> {
  logger.info('开始检查角色分配...');

  const hardhatModule = await import('hardhat');
  const hardhat = hardhatModule.default ?? hardhatModule;
  const { ethers } = hardhat;

  const accessControlAddress = process.env.ACCESS_CONTROL_MANAGER_ADDRESS;
  if (!accessControlAddress) {
    logger.error('未设置 ACCESS_CONTROL_MANAGER_ADDRESS 环境变量');
    process.exitCode = 1;
    return;
  }

  try {
    const accessControl = await ethers.getContractAt('AccessControlManager', accessControlAddress);
    logger.info(`连接到 AccessControlManager: ${accessControlAddress}`);

    const targetCaller = process.env.GOVERNANCE_CALLER || (await ethers.getSigners())[0].address;
    logger.info(`检查目标账户: ${targetCaller}`);

    let hasFailure = false;

    for (const [label, roleName] of BASELINE_ROLES) {
      const hash = roleHash(ethers, roleName);
      const hasRole = await accessControl.hasRole(hash, targetCaller);
      logger.info(`${label} (${hash}) = ${hasRole}`);
      if (!hasRole) {
        hasFailure = true;
        logger.error(`${targetCaller} 缺少基线管理角色 ${label}`);
      }
    }

    for (const [label, roleName] of OBSERVER_ROLES) {
      const hash = roleHash(ethers, roleName);
      const hasRole = await accessControl.hasRole(hash, targetCaller);
      logger.info(`${label} (${hash}) = ${hasRole}`);
    }

    const inferredPermission = await accessControl.getUserPermission(targetCaller);
    logger.info(`getUserPermission(${targetCaller}) = ${inferredPermission}`);

    if (hasFailure) {
      process.exitCode = 1;
      return;
    }

    logger.success('角色检查完成');
  } catch (error) {
    logger.error('无法连接到 AccessControlManager 合约', error instanceof Error ? error : new Error(String(error)));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  checkRoles().catch(error => {
    logger.error('角色检查过程中出错', error);
    process.exitCode = 1;
  });
}

export { checkRoles };


