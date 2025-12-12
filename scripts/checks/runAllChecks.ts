import pMap from 'p-map';
import chalk from 'chalk';
import { join } from 'path';
import logger from '../utils/logger';

const checkScripts = [
  './check-env.ts',
  './checkKeys.ts',
  './checkRole.ts',
  './checkNatspecCoverage.ts',
] as const;

async function runAllChecks(): Promise<void> {
  logger.info('开始并发运行所有检查脚本...');
  await pMap(
    checkScripts,
    async (script) => {
      logger.startSpinner(script, `运行检查: ${script}`);
      try {
        await import(join(__dirname, script));
        logger.stopSpinner(script, true, chalk.green(`✅ ${script} 通过`));
      } catch (error) {
        logger.stopSpinner(script, false, chalk.red(`❌ ${script} 失败`));
        logger.error(`${script} 执行失败`, error as Error);
        process.exitCode = 1;
      }
    },
    { concurrency: 4 },
  );

  if (process.exitCode === 1) {
    logger.error('部分检查失败，请查看上面的错误信息');
  } else {
    logger.success('所有检查通过！');
  }
}

if (require.main === module) {
  runAllChecks().catch(error => {
    logger.error('运行检查时出错', error);
    process.exitCode = 1;
  });
}

export { runAllChecks };


