#!/usr/bin/env bash
# 分层跑 Rust 测试。起因(2026-09-03):`cargo test --workspace` 要 20+ 分钟——
# 57 个测试二进制**彼此串行**(只有二进制内部并行),再叠上十几个真发 HTTP 的 live 测试。
# 逐任务每次都跑全量是纯浪费。
#
#   ./scripts/rust-test.sh fast   # lib + 快速集成测试(不含 *_live),逐任务用
#   ./scripts/rust-test.sh full   # 全量含 live,整分支终审 / 发版前用
#
# ⚠️ fast 档**不覆盖 live**,所以它绿了**不能**写成"Rust 全绿"——
# 按本项目的规矩,声称的范围必须等于实际跑过的范围。
set -uo pipefail
cd "$(dirname "$0")/../src-tauri" || exit 1

mode="${1:-fast}"
log=/tmp/rust-test-$mode.log

if [ "$mode" = "full" ]; then
  # 全量前先确认 fixture Gitea 起着:跳过判据是 fixtures/.env.local **文件在不在**,
  # 不是"服务通不通"——docker 停着时 live 测试不会跳过,而是真去连、连不上报 502 假红。
  if [ -f ../fixtures/.env.local ] && ! docker ps --format '{{.Names}}' | grep -qx skillsync-fixture-gitea; then
    echo "✗ fixtures/.env.local 在,但 skillsync-fixture-gitea 没起 —— live 测试会假红。"
    echo "  先跑: cd fixtures && docker compose up -d"
    exit 2
  fi
  cargo test --workspace --no-fail-fast >"$log" 2>&1
else
  # 不含 *_live 的二进制。cargo test 没有 exclude,所以显式列出要跑的。
  args=(--lib)
  for f in tests/*.rs; do
    n=$(basename "$f" .rs)
    case "$n" in *_live) continue;; esac
    args+=(--test "$n")
  done
  cargo test "${args[@]}" --no-fail-fast >"$log" 2>&1
fi
code=$?

# 🔴 判断"通过"的那个数必须是被判断的那条命令自己返回的,别隔管道或花括号。
# 结果行数也要报:进程被杀 / fail-fast 截断时,行数会明显偏少。
lines=$(grep -c '^test result' "$log")
echo "EXIT=$code  结果行=$lines  日志=$log"
grep -E '^test result' "$log" | awk '{p+=$4;f+=$6;i+=$8} END{print "PASSED="p" FAILED="f" IGNORED="i}'
grep -E '^failures:' "$log" && sed -n '/^failures:/,/^test result/p' "$log" | head -40
exit $code
