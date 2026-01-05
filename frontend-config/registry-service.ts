import { Contract, JsonRpcProvider, Interface } from 'ethers';

// 统计视图最小 ABI
const STATISTICS_VIEW_ABI = [
  'function getGlobalSnapshot() external view returns (tuple(uint256 activeUsers, uint256 totalCollateral, uint256 totalDebt, uint256 timestamp))',
];

// Registry 最小 ABI 由调用方传入（测试用例中提供）
// KECCAK 常量
const KEY_STATS = '0x56554e96f185bdbf1ecf716aa4a28a3809d90bd3cd6b1da5a57f50b63c9bcf36'; // keccak256("VAULT_STATISTICS")
const KEY_VAULT_CORE = '0xeb9e37aad71381ee1de5dd73c984081b0c38abc1d5ddc97e7d52a9db88f777f9'; // keccak256("VAULT_CORE")

export type GlobalSnapshot = {
  activeUsers: bigint;
  totalCollateral: bigint;
  totalDebt: bigint;
  timestamp: bigint;
};

export class RegistryQueryService {
  private registry: Contract;
  private provider: JsonRpcProvider | any;

  constructor(provider: JsonRpcProvider | any, registryAddress: string, registryAbi: string[]) {
    this.provider = provider;
    this.registry = new Contract(registryAddress, registryAbi, provider);
  }

  async getGlobalStatisticsSnapshot(): Promise<GlobalSnapshot | null> {
    // 1) 优先 KEY_STATS
    const statsAddr: string = await this.registry.getModule(KEY_STATS);
    if (statsAddr && statsAddr !== '0x0000000000000000000000000000000000000000') {
      return this.fetchSnapshot(statsAddr);
    }

    // 2) 回退 KEY_VAULT_CORE → viewContractAddrVar()
    const vaultCoreAddr: string = await this.registry.getModule(KEY_VAULT_CORE);
    if (!vaultCoreAddr || vaultCoreAddr === '0x0000000000000000000000000000000000000000') {
      return null;
    }

    const vaultCore = new Contract(
      vaultCoreAddr,
      ['function viewContractAddrVar() external view returns (address)'],
      this.provider,
    );
    const viewAddr: string = await vaultCore.viewContractAddrVar();
    if (!viewAddr || viewAddr === '0x0000000000000000000000000000000000000000') {
      return null;
    }

    return this.fetchSnapshot(viewAddr);
  }

  private async fetchSnapshot(viewAddr: string): Promise<GlobalSnapshot | null> {
    const statsView = new Contract(viewAddr, STATISTICS_VIEW_ABI, this.provider);
    try {
      const snap = await statsView.getGlobalSnapshot();
      // 返回结构体保持 bigint 类型，符合 ethers v6 默认返回
      return {
        activeUsers: snap.activeUsers,
        totalCollateral: snap.totalCollateral,
        totalDebt: snap.totalDebt,
        timestamp: snap.timestamp,
      };
    } catch {
      return null;
    }
  }
}

export default RegistryQueryService;


