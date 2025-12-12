import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import logger from '../utils/logger';
import { generateAbiDocs } from './generateAbiDocs';
import { generateErrorDocs } from './generateErrorDocs';

/*
 * generateAllDocs.ts
 * 用法：
 *   npx ts-node scripts/generateAllDocs.ts --docs
 *   npx ts-node scripts/generateAllDocs.ts --coverage
 */
const args = process.argv.slice(2);

function run(cmd: string): void {
  logger.info(`执行命令: ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

const OUTPUT_DIR = path.join(__dirname, '../../docs/contracts/en');
const MARKER = '📌 本文档由 solidity-docgen 自动生成';

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function runDocgen(tmpOut: string): void {
  // 使用 hardhat 插件执行 docgen，并输出到临时目录
  const cmd = `npx hardhat docgen --output ${tmpOut} --no-compile`;
  run(cmd);
}

function copyWithCheck(tmpOut: string): void {
  const files = fs.readdirSync(tmpOut);
  ensureDir(OUTPUT_DIR);
  for (const f of files) {
    const src = path.join(tmpOut, f);
    if (fs.statSync(src).isDirectory()) continue;
    const dest = path.join(OUTPUT_DIR, f);

    // 若目标已存在且不是自动生成，则备份
    if (fs.existsSync(dest)) {
      const old = fs.readFileSync(dest, 'utf-8');
      if (!old.includes(MARKER)) {
        const backup = dest.replace(/\.md$/i, `.manual.bak.${Date.now()}.md`);
        fs.renameSync(dest, backup);
        logger.warning(`检测到手写文档，已备份为 ${path.basename(backup)}`);
      }
    }

    // 读取新文件并添加生成标记
    let newContent = fs.readFileSync(src, 'utf-8');
    if (!newContent.includes(MARKER)) {
      newContent += `\n\n> ${MARKER}。最新更新于 ${new Date().toISOString().slice(0, 10)}。`;
    }
    fs.writeFileSync(dest, newContent);
    logger.success(`写入 ${path.basename(dest)}`);
  }
}

async function main(): Promise<void> {
  if (args.includes('--docs')) {
    logger.info('开始生成合约文档...');
    
    // 生成 NatSpec 文档
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docgen-'));
    runDocgen(tmpDir);
    copyWithCheck(tmpDir);
    
    // 生成 ABI 文档
    logger.info('开始生成 ABI 文档...');
    await generateAbiDocs();
    
    // 生成错误文档
    logger.info('开始生成错误文档...');
    await generateErrorDocs();
    
    logger.success('所有文档生成完成！');
  }

  if (args.includes('--coverage')) {
    logger.info('检查 NatSpec 文档覆盖率...');
    const thresholdArg = args.find((a) => a.startsWith('--minCoverage='));
    const cmd = `npx ts-node scripts/checks/checkNatspecCoverage.ts${thresholdArg ? ' ' + thresholdArg : ''}`;
    run(cmd);
  }
}

// 执行主函数（避免顶层 await 对 TS 配置的要求）
void main();