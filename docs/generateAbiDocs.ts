import fs from 'fs';
import path from 'path';
import glob from 'glob';
import logger from '../utils/logger';

const ARTIFACTS_DIR = path.join(__dirname, '../../artifacts/contracts');
const OUTPUT_DIR = path.join(__dirname, '../../docs/abi');
const MARKER = '📌 本文档由 ABI 文档生成器自动生成';

// ABI 类型定义
interface AbiInput {
  name: string;
  type: string;
  indexed?: boolean;
}

interface AbiOutput {
  name: string;
  type: string;
}

interface AbiItem {
  type: string;
  name?: string;
  inputs: AbiInput[];
  outputs?: AbiOutput[];
  stateMutability?: string;
}

interface ContractData {
  abi: AbiItem[];
}

// 确保输出目录存在
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// 查找所有合约 ABI 文件
async function findAbiFiles(): Promise<string[]> {
  logger.startSpinner('find-abi', '正在查找合约 ABI 文件...');
  const files = glob.sync('**/*.json', { cwd: ARTIFACTS_DIR, nodir: true });
  const abiFiles = files.filter(file => !file.endsWith('.dbg.json'));
  logger.stopSpinner('find-abi', true, `找到 ${abiFiles.length} 个合约 ABI 文件`);
  return abiFiles;
}

// 生成单个合约的 Markdown 文档
function generateContractDoc(abiPath: string): void {
  const fullPath = path.join(ARTIFACTS_DIR, abiPath);
  const contractData = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as ContractData;
  
  // 跳过接口或库
  if (!contractData.abi || contractData.abi.length === 0) {
    return;
  }
  
  const contractName = path.basename(abiPath, '.json');
  const contractDir = path.dirname(abiPath).replace(/^.*\/contracts\//, '');
  
  // 创建输出目录
  const outDir = path.join(OUTPUT_DIR, contractDir);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  
  const outPath = path.join(outDir, `${contractName}.md`);
  
  let md = `# ${contractName} ABI 文档\n\n`;
  md += `**合约路径:** \`${contractDir}/${contractName}.sol\`\n\n`;
  md += `**生成时间:** ${new Date().toISOString().split('T')[0]}\n\n`;
  md += '## 目录\n\n';
  
  // 分类 ABI 项
  const functions = contractData.abi.filter(item => item.type === 'function');
  const events = contractData.abi.filter(item => item.type === 'event');
  const errors = contractData.abi.filter(item => item.type === 'error');
  
  // 添加目录
  if (functions.length > 0) md += '- [函数](#函数)\n';
  if (events.length > 0) md += '- [事件](#事件)\n';
  if (errors.length > 0) md += '- [错误](#错误)\n';
  
  md += '\n';
  
  // 添加函数
  if (functions.length > 0) {
    md += '## 函数\n\n';
    functions.forEach(fn => {
      const signature = `${fn.name}(${fn.inputs.map(p => p.type).join(',')})`;
      const stateMutability = fn.stateMutability ? ` (${fn.stateMutability})` : '';
      
      md += `### \`${signature}\`${stateMutability}\n\n`;
      
      // 参数表
      if (fn.inputs.length > 0) {
        md += '#### 输入参数\n\n';
        md += '| 名称 | 类型 | 描述 |\n|---|---|---|\n';
        fn.inputs.forEach(p => {
          md += `| ${p.name || '-'} | \`${p.type}\` |  |\n`;
        });
        md += '\n';
      }
      
      // 返回值表
      if (fn.outputs && fn.outputs.length > 0) {
        md += '#### 返回值\n\n';
        md += '| 名称 | 类型 | 描述 |\n|---|---|---|\n';
        fn.outputs.forEach((o, idx) => {
          md += `| ${o.name || `返回值 ${idx}`} | \`${o.type}\` |  |\n`;
        });
        md += '\n';
      }
      
      md += '---\n\n';
    });
  }
  
  // 添加事件
  if (events.length > 0) {
    md += '## 事件\n\n';
    events.forEach(evt => {
      const signature = `${evt.name}(${evt.inputs.map(p => p.type).join(',')})`;
      
      md += `### \`${signature}\`\n\n`;
      
      if (evt.inputs.length > 0) {
        md += '| 名称 | 类型 | 索引 | 描述 |\n|---|---|:---:|---|\n';
        evt.inputs.forEach(p => {
          md += `| ${p.name || '-'} | \`${p.type}\` | ${p.indexed ? '✅' : '❌'} |  |\n`;
        });
        md += '\n';
      }
      
      md += '---\n\n';
    });
  }
  
  // 添加错误
  if (errors.length > 0) {
    md += '## 错误\n\n';
    errors.forEach(err => {
      const signature = `${err.name}(${err.inputs.map(p => p.type).join(',')})`;
      
      md += `### \`${signature}\`\n\n`;
      
      if (err.inputs.length > 0) {
        md += '| 名称 | 类型 | 描述 |\n|---|---|---|\n';
        err.inputs.forEach(p => {
          md += `| ${p.name || '-'} | \`${p.type}\` |  |\n`;
        });
        md += '\n';
      }
      
      md += '---\n\n';
    });
  }
  
  // 添加生成标记
  md += `\n> ${MARKER}。最新更新于 ${new Date().toISOString().slice(0, 10)}。`;
  
  fs.writeFileSync(outPath, md);
  logger.info(`生成文档: ${contractDir}/${contractName}.md`);
}

// 主函数
export async function generateAbiDocs(): Promise<void> {
  logger.info('开始生成 ABI 文档...');
  
  try {
    const abiFiles = await findAbiFiles();
    
    // 统计生成进度
    let processed = 0;
    const total = abiFiles.length;
    
    for (const abiFile of abiFiles) {
      generateContractDoc(abiFile);
      processed++;
      
      // 显示进度条
      logger.progressBar(processed, total, '生成 ABI 文档');
    }
    
    logger.success(`ABI 文档生成完成，共 ${processed} 个合约`);
  } catch (error) {
    logger.error('生成 ABI 文档时出错', error as Error);
    process.exitCode = 1;
  }
}

// 如果直接运行此脚本
if (require.main === module) {
  generateAbiDocs();
} 