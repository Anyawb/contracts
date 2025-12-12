#!/bin/bash

# 整理根目录下的文件，将它们移动到正确的子文件夹中
# 根据文件名和内容判断文件应该属于哪个文件夹

cd "$(dirname "$0")"

echo "开始整理根目录下的文件..."
echo ""

# 定义文件映射规则（文件名模式 -> 目标文件夹）
declare -A file_mapping=(
    # Access 相关
    ["AccessControl"]="src/access"
    ["Access"]="src/access"
    
    # Core 相关
    ["CoinGeckoPriceUpdater"]="src/core"
    ["PriceOracle"]="src/core"
    ["BaseService"]="src/core"
    
    # Interfaces (以 I 开头的通常是接口)
    ["^I[A-Z]"]="src/interfaces"
    
    # Libraries
    ["Library"]="src/libraries"
    ["Lib"]="src/libraries"
    
    # Mocks
    ["Mock"]="src/Mocks"
    
    # Monitor
    ["Degradation"]="src/monitor"
    ["Monitor"]="src/monitor"
    
    # Registry
    ["Registry"]="src/registry"
    
    # Reward
    ["Reward"]="src/Reward"
    
    # Token
    ["Token"]="src/Token"
    ["RWA"]="src/Token"
    
    # Vault
    ["Vault"]="src/Vault"
    
    # Constants
    ["ActionKeys"]="src/constants"
    ["DataPush"]="src/constants"
    ["ModuleKeys"]="src/constants"
    
    # Errors
    ["Error"]="src/errors"
    ["StandardErrors"]="src/errors"
    
    # Governance
    ["Governance"]="src/Governance"
    ["CrossChain"]="src/Governance"
    
    # Strategies
    ["Strategy"]="src/strategies"
    
    # Utils
    ["Utils"]="src/utils"
    ["View"]="src/utils"
)

# 移动文件的函数
move_file() {
    local file="$1"
    local target_dir="$2"
    local basename=$(basename "$file")
    
    # 检查目标目录是否存在
    if [ ! -d "$target_dir" ]; then
        echo "⚠️  目标目录不存在: $target_dir，跳过 $basename"
        return 1
    fi
    
    # 检查目标文件是否已存在
    if [ -f "$target_dir/$basename" ]; then
        # 比较文件内容
        if cmp -s "$file" "$target_dir/$basename"; then
            echo "✓ $basename 已存在于 $target_dir，删除根目录副本"
            rm "$file"
        else
            echo "⚠️  $basename 在 $target_dir 已存在但内容不同，保留根目录副本为 ${basename}.root"
            mv "$file" "${file}.root"
        fi
    else
        echo "→ 移动 $basename 到 $target_dir"
        mv "$file" "$target_dir/"
    fi
}

# 处理 Solidity 文件
echo "=== 处理 Solidity 文件 ==="
for file in $(find . -maxdepth 1 -type f -name "*.sol" | sort); do
    basename=$(basename "$file" .sol)
    moved=false
    
    # 检查是否已经在 src/ 的某个子文件夹中
    for dir in src/access src/core src/interfaces src/libraries src/Mocks src/monitor src/registry src/Reward src/Token src/Vault src/constants src/errors src/Governance src/strategies src/utils; do
        if [ -f "$dir/$basename.sol" ]; then
            echo "✓ $basename.sol 已存在于 $dir，删除根目录副本"
            rm "$file"
            moved=true
            break
        fi
    done
    
    if [ "$moved" = true ]; then
        continue
    fi
    
    # 根据文件名模式判断目标文件夹
    target_dir=""
    
    # 接口文件（以 I 开头）
    if [[ "$basename" =~ ^I[A-Z] ]]; then
        target_dir="src/interfaces"
    # Mock 文件
    elif [[ "$basename" =~ Mock ]]; then
        target_dir="src/Mocks"
    # Library 文件
    elif [[ "$basename" =~ Library$ ]] || [[ "$basename" =~ Lib$ ]]; then
        target_dir="src/libraries"
    # Access 相关
    elif [[ "$basename" =~ AccessControl ]] || [[ "$basename" =~ ^Access ]]; then
        target_dir="src/access"
    # Core 相关
    elif [[ "$basename" =~ CoinGecko ]] || [[ "$basename" =~ PriceOracle ]] || [[ "$basename" =~ BaseService ]]; then
        target_dir="src/core"
    # Monitor 相关
    elif [[ "$basename" =~ Degradation ]] || [[ "$basename" =~ Monitor ]]; then
        target_dir="src/monitor"
    # Registry 相关
    elif [[ "$basename" =~ Registry ]]; then
        target_dir="src/registry"
    # Reward 相关
    elif [[ "$basename" =~ Reward ]]; then
        target_dir="src/Reward"
    # Token 相关
    elif [[ "$basename" =~ Token ]] || [[ "$basename" =~ ^RWA ]]; then
        target_dir="src/Token"
    # Vault 相关
    elif [[ "$basename" =~ Vault ]]; then
        target_dir="src/Vault"
    # Constants 相关
    elif [[ "$basename" =~ ActionKeys ]] || [[ "$basename" =~ DataPush ]] || [[ "$basename" =~ ModuleKeys ]]; then
        target_dir="src/constants"
    # Errors 相关
    elif [[ "$basename" =~ Error ]]; then
        target_dir="src/errors"
    # Governance 相关
    elif [[ "$basename" =~ Governance ]] || [[ "$basename" =~ CrossChain ]]; then
        target_dir="src/Governance"
    # Strategies 相关
    elif [[ "$basename" =~ Strategy ]]; then
        target_dir="src/strategies"
    # Utils 相关
    elif [[ "$basename" =~ View ]] || [[ "$basename" =~ Utils ]]; then
        target_dir="src/utils"
    fi
    
    if [ -n "$target_dir" ]; then
        move_file "$file" "$target_dir"
    else
        echo "? 无法确定 $basename.sol 的目标位置，保留在根目录"
    fi
done

echo ""
echo "=== 处理测试文件 ==="
# 测试文件应该移动到 test/ 目录
for file in $(find . -maxdepth 1 -type f -name "*.test.ts" -o -name "*.spec.ts" | sort); do
    basename=$(basename "$file")
    if [ -f "test/$basename" ]; then
        if cmp -s "$file" "test/$basename"; then
            echo "✓ $basename 已存在于 test/，删除根目录副本"
            rm "$file"
        else
            echo "⚠️  $basename 在 test/ 已存在但内容不同，保留根目录副本为 ${basename}.root"
            mv "$file" "${file}.root"
        fi
    else
        echo "→ 移动 $basename 到 test/"
        mv "$file" "test/"
    fi
done

echo ""
echo "=== 处理文档文件 ==="
# 文档文件移动到 docs/ 目录
for file in $(find . -maxdepth 1 -type f -name "*.md" ! -name "README.md" | sort); do
    basename=$(basename "$file")
    if [ -f "docs/$basename" ]; then
        if cmp -s "$file" "docs/$basename"; then
            echo "✓ $basename 已存在于 docs/，删除根目录副本"
            rm "$file"
        else
            echo "⚠️  $basename 在 docs/ 已存在但内容不同，保留根目录副本为 ${basename}.root"
            mv "$file" "${file}.root"
        fi
    else
        echo "→ 移动 $basename 到 docs/"
        mv "$file" "docs/"
    fi
done

echo ""
echo "整理完成！"
echo ""
echo "剩余根目录文件统计:"
find . -maxdepth 1 -type f \( -name "*.sol" -o -name "*.test.ts" -o -name "*.md" ! -name "README.md" \) | wc -l | xargs echo "  文件数:"
