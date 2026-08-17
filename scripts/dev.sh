#!/usr/bin/env bash
# pnpm dev 的外壳:起 tauri dev 之前把内网配置(编译期常量)加载进环境。
#
# 为什么要有这个脚本(2026-08-17):此前 `pnpm dev` 是裸的 `tauri dev`,
# 不带任何配置,于是每次真机验收都得先手敲
#   set -a; . fixtures/.env.gitea.local; set +a
# 忘了敲的表现是商店一片空白 +「这个版本没有配置公司技能库」——看起来像功能坏了,
# 实际只是没注入常量。**验收本来就容易被跳过,不该再加一道手动步骤。**
#
# 铁律 5 仍然成立:这里只引用文件名,真实地址在 fixtures/.env.gitea.local 里,
# 那个文件被 .gitignore 的 `*.local` 排除,不进版本控制。
# 加载成功也**不打印具体值**——终端输出会被截图分享出去。
set -euo pipefail

ENV_FILE="fixtures/.env.gitea.local"

if [ "${SKILLSYNC_NO_INTRANET:-}" = "1" ]; then
  # 未配置态**是一个要能随时进的真实场景**,不是"忘了配"的次品:
  # 2026-08-17 真机验收就是在这个态下暴露了「广场入口在唯一条目时整个消失」
  # ——内建源没配置 → registry::list 给空 repos → 广场成了切换器里的唯一条目
  # → 撞上 entries.length <= 1 早退 → 整排切换器消失。带着配置永远撞不到它。
  echo "[dev] SKILLSYNC_NO_INTRANET=1:按「未配置内网」启动(用于验这一档的界面表现)"
elif [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  echo "[dev] 已加载 $ENV_FILE(内建技能库配置已注入)"
else
  echo "[dev] 没找到 $ENV_FILE,按「未配置内网」启动。"
  echo "[dev] 要连公司技能库,见 docs/部署分发指南.md 的编译期变量一节。"
fi

exec pnpm exec tauri dev "$@"
