#!/usr/bin/env bash
set -e

LOG=test-full.log
ERROR_LOG=test-errors.log
PENDING_LOG=test-pending.log

echo "开始运行全量测试..."
echo "测试日志将保存到: $LOG"
echo "错误信息将保存到: $ERROR_LOG"
echo "Pending 信息将保存到: $PENDING_LOG"
echo ""

# 运行测试并将输出保存到日志文件（始终生成 pending 摘要）
npm test > "$LOG" 2>&1
TEST_EXIT_CODE=$?

# ============ Pending 提取（无论成功/失败都执行） ============
echo "=== Pending 测试摘要 ===" > "$PENDING_LOG"
echo "" >> "$PENDING_LOG"

echo "Pending 统计（可能为空）:" >> "$PENDING_LOG"
grep -E "[0-9]+ pending" "$LOG" | head -20 >> "$PENDING_LOG" || true
echo "" >> "$PENDING_LOG"

echo "Pending 的测试用例（最多100条，按日志出现顺序）:" >> "$PENDING_LOG"
# Mocha(spec) reporter 通常用 "  - " 标记 pending tests
grep -E "^  - " "$LOG" | head -100 >> "$PENDING_LOG" || true
echo "" >> "$PENDING_LOG"

PENDING_COUNT_LINE="$(grep -E "[0-9]+ pending" "$LOG" | tail -1 || true)"
if [ -n "$PENDING_COUNT_LINE" ]; then
  echo "PENDING_SUMMARY=$PENDING_COUNT_LINE"
else
  echo "PENDING_SUMMARY=<not found in log>"
fi

echo "Pending 信息已保存到: $PENDING_LOG"
echo "Pending 样例（最后 20 行）:"
tail -n 20 "$PENDING_LOG" || true

if [ "$TEST_EXIT_CODE" -eq 0 ]; then
    echo ""
    echo "STATUS=SUCCESS"
    echo "所有测试通过！"
    exit 0
else
    echo ""
    echo "STATUS=FAILED"
    echo ""

    # 提取所有失败信息到单独的错误日志
    echo "=== 测试失败摘要 ===" > "$ERROR_LOG"
    echo "" >> "$ERROR_LOG"

    # 提取失败的测试用例名称
    echo "失败的测试用例:" >> "$ERROR_LOG"
    grep -E "  ✖|  ×|  failing|AssertionError|Error:" "$LOG" | head -50 >> "$ERROR_LOG" || true
    echo "" >> "$ERROR_LOG"

    # 提取详细的错误堆栈
    echo "=== 详细错误信息 ===" >> "$ERROR_LOG"
    echo "" >> "$ERROR_LOG"

    # 提取所有包含 "Error:" 或 "AssertionError" 的行及其上下文
    grep -A 10 -B 5 -E "Error:|AssertionError|FAILED|failing" "$LOG" >> "$ERROR_LOG" || true

    # 如果 grep 没有找到，尝试提取最后 100 行作为错误信息
    if [ ! -s "$ERROR_LOG" ] || [ $(wc -l < "$ERROR_LOG") -lt 10 ]; then
        echo "提取最后 100 行日志作为错误信息:" >> "$ERROR_LOG"
        tail -n 100 "$LOG" >> "$ERROR_LOG"
    fi

    echo ""
    echo "错误日志已保存到: $ERROR_LOG"
    echo "完整测试日志已保存到: $LOG"
    echo ""
    echo "最后 40 行错误信息:"
    tail -n 40 "$ERROR_LOG"

    exit 1
fi
