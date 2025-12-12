import fs from 'fs';
import path from 'path';
import glob from 'glob';
import logger from '../utils/logger';

const CONTRACTS_DIR = path.join(__dirname, '../../contracts');
const OUTPUT_DIR = path.join(__dirname, '../../docs/errors');
const MARKER = '📌 本文档由错误文档生成器自动生成';

// 确保输出目录存在
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// 错误定义的正则表达式
const ERROR_REGEX = /error\s+([A-Za-z0-9_]+)(?:\s*\(([^)]*)\))?\s*(?:\/\/\s*(.*))?/g;

// 查找所有合约文件
async function findContractFiles(): Promise<string[]> {
  logger.startSpinner('find-contracts', '正在查找合约文件...');
  const files = glob.sync('**/*.sol', { cwd: CONTRACTS_DIR, nodir: true });
  logger.stopSpinner('find-contracts', true, `找到 ${files.length} 个合约文件`);
  return files;
}

// 解析错误定义
interface ErrorDefinition {
  name: string;
  params: string[];
  description?: string;
  file: string;
  lineNumber: number;
}

// 从合约文件中提取错误定义
async function extractErrorDefinitions(contractFile: string): Promise<ErrorDefinition[]> {
  const filePath = path.join(CONTRACTS_DIR, contractFile);
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  
  const errors: ErrorDefinition[] = [];
  
  // 检查每一行
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // 重置正则表达式状态
    ERROR_REGEX.lastIndex = 0;
    
    // 查找错误定义
    let match;
    while ((match = ERROR_REGEX.exec(line)) !== null) {
      const [, name, paramsStr, description] = match;
      
      // 解析参数
      const params = paramsStr ? 
        paramsStr.split(',').map(param => param.trim()) : 
        [];
      
      errors.push({
        name,
        params,
        description: description?.trim(),
        file: contractFile,
        lineNumber: i + 1
      });
    }
  }
  
  return errors;
}

// 生成错误文档
async function generateErrorDocs(): Promise<void> {
  logger.info('开始生成错误文档...');
  
  try {
    const contractFiles = await findContractFiles();
    
    // 收集所有错误定义
    const allErrors: ErrorDefinition[] = [];
    
    for (const file of contractFiles) {
      const errors = await extractErrorDefinitions(file);
      allErrors.push(...errors);
    }
    
    // 按合约分组
    const errorsByContract = new Map<string, ErrorDefinition[]>();
    
    for (const error of allErrors) {
      const contractName = path.basename(error.file, '.sol');
      
      if (!errorsByContract.has(contractName)) {
        errorsByContract.set(contractName, []);
      }
      
      errorsByContract.get(contractName)?.push(error);
    }
    
    // 生成文档
    let indexMd = '# 错误文档索引\n\n';
    indexMd += '| 合约 | 错误数量 | 链接 |\n|---|:---:|---|\n';
    
    for (const [contractName, errors] of errorsByContract.entries()) {
      // 跳过没有错误的合约
      if (errors.length === 0) continue;
      
      // 生成单个合约的错误文档
      const contractMd = `# ${contractName} 错误文档\n\n`;
      const contractPath = errors[0].file;
      
      let errorsMd = `**合约路径:** \`${contractPath}\`\n\n`;
      errorsMd += '## 目录\n\n';
      
      for (const error of errors) {
        errorsMd += `- [${error.name}](#${error.name.toLowerCase()})\n`;
      }
      
      errorsMd += '\n## 错误详情\n\n';
      
      for (const error of errors) {
        const paramsStr = error.params.length > 0 ? 
          `(${error.params.join(', ')})` : 
          '';
        
        errorsMd += `### ${error.name}\n\n`;
        errorsMd += `\`\`\`solidity\nerror ${error.name}${paramsStr};\n\`\`\`\n\n`;
        
        if (error.description) {
          errorsMd += `**描述:** ${error.description}\n\n`;
        }
        
        errorsMd += `**定义位置:** ${error.file}:${error.lineNumber}\n\n`;
        errorsMd += '---\n\n';
      }
      
      // 添加生成标记
      errorsMd += `\n> ${MARKER}。最新更新于 ${new Date().toISOString().slice(0, 10)}。`;
      
      // 写入文件
      const outPath = path.join(OUTPUT_DIR, `${contractName}.md`);
      fs.writeFileSync(outPath, contractMd + errorsMd);
      
      // 添加到索引
      indexMd += `| ${contractName} | ${errors.length} | [查看](./errors/${contractName}.md) |\n`;
      
      logger.info(`生成错误文档: ${contractName}.md (${errors.length} 个错误)`);
    }
    
    // 写入索引文件
    const indexPath = path.join(OUTPUT_DIR, '../errors.md');
    fs.writeFileSync(indexPath, indexMd);
    
    logger.success(`错误文档生成完成，共 ${allErrors.length} 个错误定义`);
  } catch (error) {
    logger.error('生成错误文档时出错', error as Error);
    process.exitCode = 1;
  }
}

// 导出函数
export { generateErrorDocs };

// 如果直接运行此脚本
if (require.main === module) {
  generateErrorDocs();
} 