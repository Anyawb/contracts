import { ethers } from "hardhat";

async function main() {
  const SystemViewFactory = await ethers.getContractFactory("SystemView");
  const bytecode = SystemViewFactory.bytecode;
  const size = (bytecode.length - 2) / 2; // 减去 0x 前缀，除以 2 得到字节数
  
  console.log(`\n=== SystemView Contract Size ===`);
  console.log(`Bytecode size: ${size} bytes (${(size / 1024).toFixed(2)} KB)`);
  console.log(`Ethereum contract size limit: 24576 bytes (24 KB)`);
  console.log(`Usage: ${((size / 24576) * 100).toFixed(2)}%`);
  
  // 对比其他 View 合约
  const views = [
    "UserView",
    "StatisticsView", 
    "PositionView",
    "HealthView",
    "BatchView",
    "AccessControlView",
    "DashboardView",
    "PreviewView",
    "RiskView"
  ];
  
  console.log("\n=== Comparison with other View contracts ===");
  const sizes: Array<{name: string, size: number}> = [];
  
  for (const viewName of views) {
    try {
      const factory = await ethers.getContractFactory(viewName);
      const viewSize = (factory.bytecode.length - 2) / 2;
      sizes.push({ name: viewName, size: viewSize });
      console.log(`${viewName.padEnd(25)}: ${viewSize.toString().padStart(6)} bytes (${(viewSize / 1024).toFixed(2)} KB) - ${((viewSize / 24576) * 100).toFixed(2)}%`);
    } catch (e: any) {
      console.log(`${viewName.padEnd(25)}: Failed - ${e.message}`);
    }
  }
  
  // 找出最大的
  sizes.sort((a, b) => b.size - a.size);
  console.log(`\n=== Largest View Contracts ===`);
  sizes.slice(0, 5).forEach((v, i) => {
    console.log(`${i + 1}. ${v.name.padEnd(25)}: ${v.size} bytes`);
  });
  
  // 检查 SystemView 的导入
  console.log(`\n=== SystemView Analysis ===`);
  if (size > 20000) {
    console.log(`⚠️  WARNING: SystemView is quite large (>20KB)`);
    console.log(`   Consider optimizing by:`);
    console.log(`   - Removing unused functions`);
    console.log(`   - Using libraries for common logic`);
    console.log(`   - Splitting into multiple smaller contracts`);
  } else if (size > 15000) {
    console.log(`⚠️  CAUTION: SystemView is moderately large (>15KB)`);
    console.log(`   Monitor size if adding more features`);
  } else {
    console.log(`✅ SystemView size is within reasonable limits`);
  }
}

main().catch(console.error);

