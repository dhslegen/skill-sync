#!/usr/bin/env bash
# 把已签名 + 已公证的 SkillSync.app 打进 dmg。
#
# # 为什么不用 tauri 自带的 dmg 打包
#
# tauri 释放的 `bundle_dmg.sh` 在**造好 dmg 之后**才调用 `hdiutil internet-enable`
# ——那个功能 macOS 10.15 就移除了,命令返回非零,而脚本开头有 `set -e`,
# 于是整段以失败告终。tauri 见状判定构建失败,**清理整个 bundle 目录**,
# 把刚公证好的 .app 连同 dmg 一起删掉(2026-08-05 连撞两次才定位到)。
#
# 所以发布流程拆成两步:`build-release.sh --bundles app` 只出 .app(签名与公证
# 都在这一步完成),再由本脚本打 dmg。本脚本只用 hdiutil 的基础能力,不碰
# internet-enable,也不做图标摆位(那正是 tauri 那套脚本复杂且易碎的原因)。
#
# 用法:./scripts/make-dmg.sh [app 路径]
#   缺省找 src-tauri/target/universal-apple-darwin/release/bundle/macos/SkillSync.app
set -euo pipefail
cd "$(dirname "$0")/.."

APP="${1:-src-tauri/target/universal-apple-darwin/release/bundle/macos/SkillSync.app}"
if [[ ! -d "$APP" ]]; then
  echo "❌ 找不到 $APP" >&2
  echo "   先跑:./scripts/build-release.sh --target universal-apple-darwin --bundles app" >&2
  exit 1
fi

VERSION="$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['version'])")"
OUT_DIR="$(dirname "$APP")/../dmg"
mkdir -p "$OUT_DIR"
DMG="$OUT_DIR/SkillSync_${VERSION}_universal.dmg"
VOLNAME="SkillSync"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# 发布前的最后一道确认:没签名/没公证的包发出去,用户双击就被 Gatekeeper 拦,
# 而这件事要到装机时才发现——宁可在这里停下
echo "==> 校验 .app 的签名与公证"
# 先把输出收进变量再匹配,**不要用 `cmd | grep -q`**:grep -q 匹配到就立刻退出,
# 上游进程收到 SIGPIPE 被杀(退出码 141),而本脚本开了 `set -o pipefail`,
# 管道取最大退出码 → "检查通过"被判成"检查失败"。2026-08-05 踩到,
# 表现是签名完好的包被拒绝出 dmg。
sign_info="$(codesign -dv --verbose=2 "$APP" 2>&1 || true)"
if ! grep -q "Authority=Developer ID Application" <<<"$sign_info"; then
  echo "❌ 没有 Developer ID 签名。设好 APPLE_SIGNING_IDENTITY 重新构建。" >&2
  exit 1
fi
# 用**退出码**判断而不是 grep 输出:spctl 不带 -vvv 时成功**一个字都不打印**,
# 拿 grep accepted 当判据会把好包判成坏包(2026-08-05 踩到)
if ! spctl -a -t install "$APP" >/dev/null 2>&1; then
  echo "❌ Gatekeeper 不认这个包(未公证或公证失败):" >&2
  spctl -a -vvv -t install "$APP" 2>&1 | head -5 >&2 || true
  exit 1
fi
if ! xcrun stapler validate "$APP" >/dev/null 2>&1; then
  echo "❌ 公证票据没装订上(staple)。缺了它,断外网的机器首次打开会卡住。" >&2
  exit 1
fi
echo "✅ 已签名 · 已公证 · 票据已装订"

echo "==> 布置 dmg 内容"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"   # 拖拽安装的目标

echo "==> 生成 $DMG"
rm -f "$DMG"
# UDZO = 压缩只读镜像,分发用的标准格式
hdiutil create -volname "$VOLNAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null

echo "==> 校验产物"
hdiutil verify "$DMG" >/dev/null 2>&1 && echo "✅ 镜像完整"
SIZE="$(python3 -c "import os;print('%.1f MB' % (os.path.getsize('$DMG')/1048576))")"
ARCHS="$(lipo -archs "$APP/Contents/MacOS/skillsync")"

echo
echo "完成:$DMG"
echo "  大小 $SIZE · 架构 $ARCHS"
echo "  已签名并公证,普通同事双击即可打开(无需右键绕过 Gatekeeper)"
