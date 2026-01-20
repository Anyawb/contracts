import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;

// 直接引入前端服务类
import { RegistryQueryService } from '../frontend-config/registry-service';

describe('RegistryQueryService – KEY_STATS prefer, KEY_VAULT_CORE fallback', function () {
  it('getGlobalStatisticsSnapshot should work with prefer-and-fallback logic', async function () {
    const [user] = await ethers.getSigners();

    // 部署 MockRegistry / MockStatisticsView / MockVaultCore
    const MockRegistryF = await ethers.getContractFactory('MockRegistry');
    const registry = await MockRegistryF.deploy();
    await registry.waitForDeployment();

    const MockStatisticsViewF = await ethers.getContractFactory('MockStatisticsView');
    const stats = await MockStatisticsViewF.deploy();
    await stats.waitForDeployment();

    const MockVaultCoreF = await ethers.getContractFactory('MockVaultCore');
    const vaultCore = await MockVaultCoreF.deploy();
    await vaultCore.waitForDeployment();

    // Keys
    // NOTE: RegistryQueryService 内部使用 hardcoded keccak 常量。
    // 为避免测试与前端常量不一致导致“命中失败”，这里直接对齐其值。
    const KEY_STATS = '0x56554e96f185bdbf1ecf716aa4a28a3809d90bd3cd6b1da5a57f50b63c9bcf36'; // keccak256("VAULT_STATISTICS")
    const KEY_VAULT_CORE = '0xeb9e37aad71381ee1de5dd73c984081b0c38abc1d5ddc97e7d52a9db88f777f9'; // keccak256("VAULT_CORE")

    // 注册 KEY_STATS -> stats
    await registry.setModule(KEY_STATS, await stats.getAddress());
    // 推送一次数据
    await stats.pushUserStatsUpdate(await user.getAddress(), ethers.parseUnits('50', 18), 0n, 0n, 0n);

    // 构造服务实例：传入 provider、registry 地址与最小 ABI
    const REGISTRY_MIN_ABI = [ 'function getModule(bytes32 key) external view returns (address)' ];
    const service = new RegistryQueryService(ethers.provider as unknown as any, await registry.getAddress(), REGISTRY_MIN_ABI);

    // 读取快照（应命中 KEY_STATS）
    let snap = await service.getGlobalStatisticsSnapshot();
    expect(snap).to.not.be.null;
    expect(snap!.totalCollateral).to.equal(ethers.parseUnits('50', 18));

    // 清空 KEY_STATS，回退到 KEY_VAULT_CORE -> viewContractAddrVar()
    await registry.setModule(KEY_STATS, '0x0000000000000000000000000000000000000000');
    await registry.setModule(KEY_VAULT_CORE, await vaultCore.getAddress());
    await vaultCore.setViewContractAddr(await stats.getAddress());

    snap = await service.getGlobalStatisticsSnapshot();
    expect(snap).to.not.be.null;
    expect(snap!.totalCollateral).to.equal(ethers.parseUnits('50', 18));
  });
});


