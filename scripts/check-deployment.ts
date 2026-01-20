/**
 * 检查本地节点上的合约部署状态
 */
const hre = require('hardhat');
const { ethers } = hre;
const fs = require('fs');
const path = require('path');

async function checkDeployment() {
  try {
    // 检查节点连接
    const blockNumber = await ethers.provider.getBlockNumber();
    console.log(`✅ 本地节点已连接，当前区块: ${blockNumber}`);
    
    // 读取部署地址
    const deployFile = path.join(__dirname, '..', 'deployments', 'localhost.json');
    
    if (!fs.existsSync(deployFile)) {
      console.log('❌ 未找到部署文件，需要部署');
      return false;
    }
    
    const deployed = JSON.parse(fs.readFileSync(deployFile, 'utf8'));
    console.log(`📋 找到 ${Object.keys(deployed).length} 个已部署的合约地址`);
    
    // 检查关键合约是否有代码
    const keyContracts = ['Registry', 'VaultCore', 'VaultRouter', 'AccessControlManager'];
    let allDeployed = true;
    
    for (const name of keyContracts) {
      const addr = deployed[name];
      if (!addr) {
        console.log(`⚠️  ${name}: 地址不存在`);
        allDeployed = false;
        continue;
      }
      
      const code = await ethers.provider.getCode(addr);
      if (!code || code === '0x') {
        console.log(`❌ ${name} @ ${addr}: 无代码（未部署）`);
        allDeployed = false;
      } else {
        console.log(`✅ ${name} @ ${addr}: 已部署`);
      }
    }
    
    return allDeployed;
  } catch (error: any) {
    if (error.message?.includes('ECONNREFUSED') || error.message?.includes('connect')) {
      console.log('❌ 无法连接到本地节点 (http://127.0.0.1:8545)');
      console.log('💡 请先运行: npm run node');
      return false;
    }
    throw error;
  }
}

checkDeployment().then(result => {
  process.exit(result ? 0 : 1);
}).catch(err => {
  console.error('检查失败:', err.message);
  process.exit(1);
});
