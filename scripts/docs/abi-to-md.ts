import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

interface AbiItem {
  type: string;
  name?: string;
  inputs?: Array<{
    name?: string;
    type: string;
  }>;
  outputs?: Array<{
    name?: string;
    type: string;
  }>;
}

interface ArtifactData {
  abi: AbiItem[];
}

/**
 * ABI 转 Markdown 文档生成器
 * 
 * 功能:
 * - 读取合约 ABI 文件
 * - 生成 Markdown 格式的文档
 * - 包含函数签名、参数和返回值表格
 */
function generateAbiMarkdown(): void {
  // Path to the generated artifact JSON (after compilation)
  const artifactPath = join(__dirname, '../artifacts/contracts/Vault/CollateralVaultView.sol/CollateralVaultView.json');

  if (!existsSync(artifactPath)) {
    console.error('Artifact not found. Please run `npx hardhat compile` first.');
    process.exit(1);
  }

  try {
    const artifactContent = readFileSync(artifactPath, 'utf8');
    const { abi }: ArtifactData = JSON.parse(artifactContent);

    // Output markdown file
    const outPath = join(__dirname, '../docs/CollateralVaultView.md');
    let md = '# CollateralVaultView ABI 文档\n\n';

    // 过滤函数并生成文档
    abi.filter((item: AbiItem) => item.type === 'function').forEach((fn: AbiItem) => {
      if (!fn.name || !fn.inputs || !fn.outputs) {
        return; // 跳过无效的函数定义
      }

      const signature = `${fn.name}(${fn.inputs.map(p => p.type).join(',')})`;
      md += `### Function: \`${signature}\`\n\n`;

      // Parameters table
      md += '| Param | Type | Description |\n|---|---|---|\n';
      if (fn.inputs.length === 0) {
        md += '| - | - | - |\n';
      } else {
        fn.inputs.forEach(p => {
          md += `| ${p.name || 'param'} | ${p.type} |  |\n`;
        });
      }

      md += '\n| Returns | Type | Description |\n|---|---|---|\n';
      if (fn.outputs.length === 0) {
        md += '| - | - | - |\n';
      } else {
        fn.outputs.forEach((o, idx) => {
          md += `| ${o.name || 'ret' + idx} | ${o.type} |  |\n`;
        });
      }

      md += '\n---\n\n';
    });

    writeFileSync(outPath, md);
    console.log('Markdown generated:', outPath);

  } catch (error) {
    console.error('Error generating markdown:', error);
    process.exit(1);
  }
}

// 执行文档生成
generateAbiMarkdown(); 