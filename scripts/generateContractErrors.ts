import * as fs from 'fs';
import * as path from 'path';
import { id } from 'ethers';

type ErrorDefinition = {
  signature: string;
  message: string;
  category:
    | 'config'
    | 'permission'
    | 'intent'
    | 'validation'
    | 'settlement'
    | 'blocks-only'
    | 'runtime';
  source: string;
};

const OUTPUT_PATH = path.resolve(__dirname, '../frontend-config/contractErrors.ts');

const ERROR_DEFINITIONS: ErrorDefinition[] = [
  {
    signature: 'ZeroAddress()',
    message: '地址不能为零。通常表示参数缺失、地址未配置，或 Registry 未正确绑定。',
    category: 'config',
    source: 'StandardErrors',
  },
  {
    signature: 'NotAContract(address addr)',
    message: '目标地址不是合约，通常表示 Registry 绑定了错误地址或部署产物漂移。',
    category: 'config',
    source: 'StandardErrors',
  },
  {
    signature: 'AmountIsZero()',
    message: '金额不能为零。调用方应先完成本地 preflight，再发起交易。',
    category: 'validation',
    source: 'StandardErrors',
  },
  {
    signature: 'AssetNotAllowed()',
    message: '当前资产未被协议允许，通常意味着白名单、产品线或部署配置未就绪。',
    category: 'validation',
    source: 'StandardErrors',
  },
  {
    signature: 'InvalidCaller()',
    message: '调用方或调用参数不符合当前路径要求。AICredits 购买场景下也可能代表重复 clientOrderId、未配置价格或支付金额不精确。',
    category: 'validation',
    source: 'StandardErrors',
  },
  {
    signature: 'ArrayLengthMismatch(uint256 length1, uint256 length2)',
    message: '数组长度不匹配。前端应先校验 tuple / 签名数组长度，再上链。',
    category: 'validation',
    source: 'StandardErrors',
  },
  {
    signature: 'SettlementIntentLib__AlreadyMatched()',
    message: '意图已被撮合或 reserve 已被消费，属于并发业务冲突，不建议自动重试。',
    category: 'intent',
    source: 'SettlementIntentLib',
  },
  {
    signature: 'SettlementIntentLib__IntentExpired()',
    message: '意图已过期。注意 expireAt 在本协议语义里是 expireBlock，而不是 unix timestamp。',
    category: 'intent',
    source: 'SettlementIntentLib',
  },
  {
    signature: 'SettlementIntentLib__InvalidSignature()',
    message: '签名无效，可能是签名人、参数、链 ID、verifyingContract 或 domain 不一致。',
    category: 'intent',
    source: 'SettlementIntentLib',
  },
  {
    signature: 'VaultBusinessLogic__InvalidLendIntentHash()',
    message: 'lend intent hash 无效，通常表示 reserve 或取消 reserve 的参数构造有误。',
    category: 'intent',
    source: 'VaultBusinessLogic',
  },
  {
    signature: 'VaultBusinessLogic__CallerNotLenderSigner()',
    message: '调用者不是 lenderSigner，本次 reserve 锁仓不允许第三方代替发起。',
    category: 'permission',
    source: 'VaultBusinessLogic',
  },
  {
    signature: 'VaultBusinessLogic__LendIntentAlreadyMatched()',
    message: 'lend intent 已被使用，不应重复 reserve 或复用旧签名。',
    category: 'intent',
    source: 'VaultBusinessLogic',
  },
  {
    signature: 'VaultBusinessLogic__AssetMismatch(address expected, address got)',
    message: '撮合过程中 reserve 资产与借款资产不一致，通常表示前端或报价层把不同资产的意图混在一起。',
    category: 'validation',
    source: 'VaultBusinessLogic',
  },
  {
    signature: 'VaultBusinessLogic__InsufficientReservedSum(uint256 totalReserved, uint256 requiredBorrow)',
    message: 'reserve 总额不足以支撑当前借款金额。应提示补 reserve 或调整报价。',
    category: 'validation',
    source: 'VaultBusinessLogic',
  },
  {
    signature: 'VaultBusinessLogic__InsufficientCollateral(uint256 current, uint256 required)',
    message: '借款人当前抵押不足。正确处理是先引导补抵押，而不是盲目重试撮合。',
    category: 'validation',
    source: 'VaultBusinessLogic',
  },
  {
    signature: 'VaultBusinessLogic__BlocksOnlyTermOutOfRange(uint256 requested, uint256 minAllowed, uint256 maxAllowed)',
    message: 'blocks-only 借款期限不在 lender 允许范围内。',
    category: 'blocks-only',
    source: 'VaultBusinessLogic',
  },
  {
    signature: 'VaultBusinessLogic__BlocksOnlyRateTooLow(uint256 requested, uint256 minRequired)',
    message: 'blocks-only 利率低于 lender 最低要求。',
    category: 'blocks-only',
    source: 'VaultBusinessLogic',
  },
  {
    signature: 'SettlementManager__OnlyVaultCore()',
    message: '当前路径只能由 VaultCore 调用。普通用户或 SDK 直接调 repayAndSettle 属于错误接入。',
    category: 'permission',
    source: 'SettlementManager',
  },
  {
    signature: 'SettlementManager__InvalidOrderId()',
    message: 'orderId 无效或无法在 ORDER_ENGINE 中解析。',
    category: 'settlement',
    source: 'SettlementManager',
  },
  {
    signature: 'SettlementManager__NotLiquidatable()',
    message: '当前订单还不满足结算/清算条件。keeper 应等待到期或新的风险信号。',
    category: 'settlement',
    source: 'SettlementManager',
  },
  {
    signature: 'SettlementManager__BorrowerCannotSelfLiquidate()',
    message: 'borrower 不能把 keeper 清算入口当普通用户入口调用。',
    category: 'permission',
    source: 'SettlementManager',
  },
  {
    signature: 'SettlementManager__NoCollateral()',
    message: '清算路径没有找到可处理的抵押品。通常需要联查价格、抵押余额和风控读面。',
    category: 'settlement',
    source: 'SettlementManager',
  },
  {
    signature: 'SettlementManager__OrderMismatch()',
    message: 'orderId 与 user / debtAsset 不匹配。',
    category: 'settlement',
    source: 'SettlementManager',
  },
  {
    signature: 'SettlementManager__DebtNotCleared()',
    message: '严格全额还款释放模式下，债务尚未完全清空。',
    category: 'settlement',
    source: 'SettlementManager',
  },
  {
    signature: 'SettlementManager__RepayPullMismatch()',
    message: 'SettlementManager 转发的还款金额与 ORDER_ENGINE 实际消耗不一致。',
    category: 'runtime',
    source: 'SettlementManager',
  },
  {
    signature: 'SettlementManager__InvalidImplementation()',
    message: '升级目标实现地址无效或没有合约代码。',
    category: 'config',
    source: 'SettlementManager',
  },
  {
    signature: 'BlocksOnlyCoordinator__OnlyVaultBusinessLogic()',
    message: '当前 blocks-only 写路径只能由 VaultBusinessLogic 进入。',
    category: 'permission',
    source: 'BlocksOnlyCoordinator',
  },
  {
    signature: 'BlocksOnlyCoordinator__OnlyBorrower()',
    message: 'repayBlocks 只能由订单 borrower 自己调用。',
    category: 'permission',
    source: 'BlocksOnlyCoordinator',
  },
  {
    signature: 'BlocksOnlyCoordinator__InvalidOrderId(uint256 orderId)',
    message: 'blocks-only orderId 不存在或超出已创建范围。',
    category: 'blocks-only',
    source: 'BlocksOnlyCoordinator',
  },
  {
    signature: 'BlocksOnlyCoordinator__OrderNotActive(uint256 orderId, uint8 status)',
    message: 'blocks-only 订单不是 ACTIVE 状态，不能继续执行当前动作。',
    category: 'blocks-only',
    source: 'BlocksOnlyCoordinator',
  },
  {
    signature: 'BlocksOnlyCoordinator__InvalidTermBlocks(uint256 termBlocks)',
    message: 'blocks-only 当前产品配置不接受该 termBlocks。',
    category: 'blocks-only',
    source: 'BlocksOnlyCoordinator',
  },
  {
    signature: 'BlocksOnlyCoordinator__InvalidRateBps(uint256 rateBps)',
    message: 'blocks-only 当前产品配置不接受该 rateBps。',
    category: 'blocks-only',
    source: 'BlocksOnlyCoordinator',
  },
  {
    signature: 'BlocksOnlyCoordinator__InvalidLender(address expected, address actual)',
    message: 'blocks-only lender 不是 Registry 中登记的 LenderPoolVault。',
    category: 'blocks-only',
    source: 'BlocksOnlyCoordinator',
  },
  {
    signature: 'BlocksOnlyCoordinator__NotMatured(uint256 orderId, uint256 maturityBlock, uint256 currentBlock)',
    message: 'blocks-only 订单尚未达到 maturityBlock，不能提前执行到期处理。',
    category: 'blocks-only',
    source: 'BlocksOnlyCoordinator',
  },
  {
    signature: 'BlocksOnlyCoordinator__NoCollateral(address borrower)',
    message: 'blocks-only 绑定抵押没有被 coordinator 正常托管，或托管余额已被破坏。',
    category: 'blocks-only',
    source: 'BlocksOnlyCoordinator',
  },
];

function buildOutput(definitions: ErrorDefinition[]): string {
  const generatedAt = new Date().toISOString();
  const entries = definitions.map((definition) => {
    const selector = id(definition.signature).slice(0, 10);
    const name = definition.signature.slice(0, definition.signature.indexOf('('));
    return {
      ...definition,
      name,
      selector,
      fragment: `error ${definition.signature}`,
    };
  });

  const definitionsBlock = entries
    .map(
      (entry) => `  {
    name: '${entry.name}',
    signature: '${entry.signature}',
    fragment: '${entry.fragment}',
    selector: '${entry.selector}',
    message: '${entry.message}',
    category: '${entry.category}',
    source: '${entry.source}',
  },`
    )
    .join('\n');

  const fragmentsBlock = entries
    .map((entry) => `  '${entry.fragment}',`)
    .join('\n');

  const messagesBlock = entries
    .map((entry) => `  ${entry.name}: '${entry.message}',`)
    .join('\n');

  const selectorsBlock = entries
    .map((entry) => `  ${entry.name}: '${entry.selector}',`)
    .join('\n');

  const selectorLookupBlock = entries
    .map((entry) => `  '${entry.selector}': '${entry.name}',`)
    .join('\n');

  return `/**
 * Contract error artifact generated from contracts/scripts/generateContractErrors.ts
 * Generated at: ${generatedAt}
 *
 * 此文件是前后端共享的 custom error selector -> 语义映射单一产物。
 * 不要在消费仓再手写第二份 selector 表。
 */

export const CONTRACT_ERROR_DEFINITIONS = [
${definitionsBlock}
] as const;

export const CONTRACT_ERROR_FRAGMENTS = [
${fragmentsBlock}
] as const;

export const CONTRACT_ERROR_MESSAGES = {
${messagesBlock}
} as const;

export const CONTRACT_ERROR_SELECTORS = {
${selectorsBlock}
} as const;

export const CONTRACT_ERROR_NAME_BY_SELECTOR = {
${selectorLookupBlock}
} as const;

export type ContractErrorDefinition = (typeof CONTRACT_ERROR_DEFINITIONS)[number];
export type ContractErrorName = keyof typeof CONTRACT_ERROR_MESSAGES;
`;
}

function main(): void {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, buildOutput(ERROR_DEFINITIONS), 'utf8');
  console.log(`generated ${OUTPUT_PATH}`);
  console.log(`contract error entries: ${ERROR_DEFINITIONS.length}`);
}

main();