#!/usr/bin/env bash
# SkillSync 发布构建(任务 13)。
#
# 职责:
#   1. 强制校验编译期注入的内网配置——缺了任何一个,构建出的包连不上公司技能库,
#      却要到用户手里才发现(app 只会显示"未配置")。这类包绝不允许流出。
#   2. macOS 上按环境变量决定 签名/公证:证书未到位时仍可出"未签名测试包",
#      但会打显眼的警告——Sequoia 起未公证应用非开发者基本打不开(设计方案 2.5⑤)。
#
# 用法:
#   export SKILLSYNC_BUILTIN_GITEA_URL="https://gitea.<内网域名>"
#   export SKILLSYNC_OAUTH_CLIENT_ID="<OAuth 应用的 Client ID>"
#   export SKILLSYNC_BUILTIN_REPO="skills/skills"
#   export SKILLSYNC_BUILTIN_BRANCH="main"
#   # macOS 签名 + 公证(证书到位后):
#   export APPLE_SIGNING_IDENTITY="Developer ID Application: <公司> (<TEAMID>)"
#   export APPLE_ID="<公证用 Apple ID>" APPLE_PASSWORD="<app 专用密码>" APPLE_TEAM_ID="<TEAMID>"
#   ./scripts/build-release.sh
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
for var in SKILLSYNC_BUILTIN_GITEA_URL SKILLSYNC_OAUTH_CLIENT_ID SKILLSYNC_BUILTIN_REPO SKILLSYNC_BUILTIN_BRANCH; do
  if [[ -z "${!var:-}" ]]; then
    echo "❌ 缺少环境变量 $var —— 没有它构建出的包连不上公司技能库" >&2
    fail=1
  fi
done
if [[ $fail -ne 0 ]]; then
  echo "发布构建终止。四个 SKILLSYNC_* 变量都设好后重试。" >&2
  exit 1
fi

case "$SKILLSYNC_BUILTIN_GITEA_URL" in
  https://*) ;;
  http://*)
    echo "⚠️  内网地址是 http(明文)。OAuth 令牌会裸奔,确认这是内网且 IT 知情。" >&2
    ;;
  *)
    echo "❌ SKILLSYNC_BUILTIN_GITEA_URL 不是 http(s) 地址: $SKILLSYNC_BUILTIN_GITEA_URL" >&2
    exit 1
    ;;
esac

if [[ "$(uname)" == "Darwin" ]]; then
  if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
    echo "⚠️  未设置 APPLE_SIGNING_IDENTITY:产物不签名,只能用于内部测试机。" >&2
    echo "    Sequoia 起,未公证的应用普通同事双击打不开(需右键打开并二次确认)。" >&2
  elif [[ -z "${APPLE_ID:-}" || -z "${APPLE_PASSWORD:-}" || -z "${APPLE_TEAM_ID:-}" ]]; then
    echo "⚠️  已设签名身份但缺公证凭证(APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID):" >&2
    echo "    产物已签名但未公证,Gatekeeper 仍会拦。" >&2
  else
    echo "✅ 签名 + 公证凭证齐备,tauri build 会自动完成签名与公证(含 staple)。"
  fi
fi

echo "==> pnpm install"
pnpm install --frozen-lockfile

echo "==> tauri build"
pnpm tauri build

echo
echo "构建完成。产物在 src-tauri/target/release/bundle/ 下:"
if [[ "$(uname)" == "Darwin" ]]; then
  ls -1 src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null || true
  ls -1d src-tauri/target/release/bundle/macos/*.app 2>/dev/null || true
else
  ls -1 src-tauri/target/release/bundle/nsis/*.exe 2>/dev/null || true
  ls -1 src-tauri/target/release/bundle/msi/*.msi 2>/dev/null || true
fi
