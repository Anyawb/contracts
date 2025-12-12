import { Interface, Result } from '@ethersproject/abi';

const ERROR_STRING_SELECTOR = '0x08c379a0';
const PANIC_SELECTOR = '0x4e487b71';

/**
 * 解码以太坊合约的 revert 错误信息。
 * 支持标准 Error(string)、Panic(uint256) 以及自定义错误。
 * @param data 交易失败时返回的 revert 数据
 * @param iface 可选，合约 ABI 接口，用于解码自定义错误
 * @returns 解码后的人类可读错误信息
 */
export function decodeRevert(data: string | null | undefined, iface?: Interface): string {
  if (!data || data === '0x') {
    return 'Empty revert data';
  }

  const selector = data.slice(0, 10);

  if (selector === ERROR_STRING_SELECTOR) {
    // Error(string) 标准错误格式
    // 0x08c379a0 + 32 bytes offset + 32 bytes length + string data
    try {
      const reasonHex = '0x' + data.slice(10 + 64); // 跳过 selector 和 offset
      
      // 检查是否有足够的数据
      if (reasonHex === '0x' || reasonHex.length < 4) {
        return 'Error(string): <无法解码>';
      }
      
      const reasonBuffer = Buffer.from(reasonHex.slice(2), 'hex');
      const reason = reasonBuffer.toString('utf8').replace(/\0/g, '');
      return `Error(string): ${reason}`;
    } catch (e) {
      return 'Error(string): <无法解码>';
    }
  }

  if (selector === PANIC_SELECTOR) {
    // Panic(uint256) 错误代码，代表低级别异常
    // 通常一个 uint256 的 panic code，附带解释
    try {
      const codeHex = '0x' + data.slice(10);
      const codeNum = parseInt(codeHex, 16);
      
      // 检查是否为有效数字
      if (isNaN(codeNum)) {
        return 'Panic(uint256): <无法解码panic code>';
      }
      
      const panicReason = panicCodeToMessage(codeNum);
      return `Panic(uint256): ${panicReason} (code: ${codeNum})`;
    } catch {
      return 'Panic(uint256): <无法解码panic code>';
    }
  }

  if (iface) {
    try {
      const decoded = iface.parseError(data);
      return `CustomError: ${decoded.name}(${formatDecodedArgs(decoded.args)})`;
    } catch {
      // 忽略错误
    }
  }

  return `Unknown selector: ${selector}`;
}

/**
 * 根据 Panic(uint256) 的 code 返回对应解释
 */
function panicCodeToMessage(code: number): string {
  switch (code) {
  case 0x01: return 'Assertion failed';
  case 0x11: return 'Arithmetic overflow/underflow';
  case 0x12: return 'Division by zero';
  case 0x21: return 'Invalid enum value';
  case 0x22: return 'Storage byte array improperly encoded';
  case 0x31: return 'Pop on empty array';
  case 0x32: return 'Array index out of bounds';
  case 0x41: return 'Memory overflow';
  case 0x51: return 'Zero-initialized variable';
  default: return 'Unknown panic code';
  }
}

/**
 * 格式化自定义错误参数为字符串
 */
function formatDecodedArgs(args: Result): string {
  if (!args || args.length === 0) return '';
  return args.map(arg => formatArg(arg)).join(', ');
}

/**
 * 简单格式化参数，支持对象递归（如果需要可扩展）
 */
function formatArg(arg: unknown): string {
  if (arg === null || arg === undefined) return String(arg);
  if (typeof arg === 'object') {
    try {
      return JSON.stringify(arg);
    } catch {
      return '[Object]';
    }
  }
  return String(arg);
}
