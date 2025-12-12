#!/usr/bin/env ts-node

import hardhat from 'hardhat';
import logger from '../utils/logger';

const { ethers } = hardhat;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

async function checkRoles(): Promise<void> {
  logger.info('开始检查角色分配...');

  const accessControlAddress = process.env.ACCESS_CONTROL_MANAGER_ADDRESS;
  if (!accessControlAddress) {
    logger.error('未设置 ACCESS_CONTROL_MANAGER_ADDRESS 环境变量');
    process.exitCode = 1;
    return;
  }

  try {
    const accessControl = await ethers.getContractAt('AccessControlManager', accessControlAddress);
    logger.info(`连接到 AccessControlManager: ${accessControlAddress}`);

    const roles: Record<string, string> = {
      DEFAULT_ADMIN_ROLE: ethers.ZeroHash,
    };

    try {
      const accessControlAny = accessControl as unknown as {
        GOVERNANCE_ROLE?: () => Promise<string>;
        OPERATOR_ROLE?: () => Promise<string>;
        KEEPER_ROLE?: () => Promise<string>;
        getRoleMemberCount: (role: string) => Promise<bigint>;
        getRoleMember: (role: string, index: number) => Promise<string>;
      };
      const governanceRole = await accessControlAny.GOVERNANCE_ROLE?.();
      const operatorRole = await accessControlAny.OPERATOR_ROLE?.();
      const keeperRole = await accessControlAny.KEEPER_ROLE?.();
      if (governanceRole) roles['GOVERNANCE_ROLE'] = governanceRole;
      if (operatorRole) roles['OPERATOR_ROLE'] = operatorRole;
      if (keeperRole) roles['KEEPER_ROLE'] = keeperRole;
    } catch (error) {
      logger.warning('无法获取某些角色常量，将仅检查默认管理员角色');
    }

    const [deployer] = await ethers.getSigners();
    void deployer;

    for (const [roleName, roleHash] of Object.entries(roles)) {
      if (!roleHash) continue;
      logger.info(`检查 ${roleName} (${roleHash})...`);
      try {
        const accessControlAny = accessControl as unknown as {
          getRoleMemberCount: (role: string) => Promise<bigint>;
          getRoleMember: (role: string, index: number) => Promise<string>;
        };
        const memberCount = await accessControlAny.getRoleMemberCount(roleHash);
        logger.info(`${roleName} 有 ${memberCount} 个成员`);
        for (let i = 0; i < memberCount; i++) {
          const member = await accessControlAny.getRoleMember(roleHash, i);
          logger.info(`- 成员 ${i + 1}: ${member}`);
          if (member === ZERO_ADDRESS) {
            logger.warning(`${roleName} 分配给了零地址`);
          }
        }
      } catch (error) {
        logger.error(`检查 ${roleName} 时出错: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      const accessControlAny = accessControl as unknown as { getRoleMemberCount: (role: string) => Promise<bigint> };
      const adminCount = await accessControlAny.getRoleMemberCount(roles.DEFAULT_ADMIN_ROLE);
      if (adminCount === 0n) {
        logger.error('DEFAULT_ADMIN_ROLE 没有成员，这可能导致无法管理角色');
        process.exitCode = 1;
      } else {
        logger.success(`DEFAULT_ADMIN_ROLE 有 ${adminCount} 个成员`);
      }
    } catch (error) {
      logger.error(`检查角色成员数量时出错: ${error instanceof Error ? error.message : String(error)}`);
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


