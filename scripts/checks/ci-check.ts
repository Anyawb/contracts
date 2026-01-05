import { execSync } from 'child_process';
import logger from '../utils/logger';

// 定义检查项目
const checks = [
  {
    name: '编译',
    command: 'npx hardhat compile',
  },
  {
    name: '测试',
    command: 'npx hardhat test',
  },
  {
    name: '代码风格',
    command: 'npm run format:check',
  },
  {
    name: '代码检查',
    command: 'npm run lint',
  },
  {
    name: 'NatSpec 文档覆盖率',
    command: 'npx ts-node scripts/checks/checkNatspecCoverage.ts --minCoverage=90',
  },
];

// 运行所有检查
async function runChecks(): Promise<void> {
  logger.info('开始运行 CI 检查...');
  
  let hasError = false;
  
  for (const check of checks) {
    logger.startSpinner(check.name, `运行检查: ${check.name}`);
    
    try {
      execSync(check.command, { stdio: 'pipe' });
      logger.stopSpinner(check.name, true, `✅ ${check.name} 通过`);
    } catch (error) {
      hasError = true;
      logger.stopSpinner(check.name, false, `❌ ${check.name} 失败`);
      
      if (error instanceof Error) {
        logger.error(error.message);
      }
    }
  }
  
  if (hasError) {
    logger.error('CI 检查失败，请修复上述问题');
    process.exitCode = 1;
  } else {
    logger.success('所有 CI 检查通过！');
  }
}

// 执行检查
runChecks().catch((e) => {
  logger.error(e?.message || String(e));
  process.exitCode = 1;
});