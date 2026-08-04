# 上游 `npx skills init` ground truth(M4 任务 4 录制纪要)

录制时间:2026-08-04。命令:`npx skills@1.5.20 init <name>`,在隔离 HOME 下跑。

## 产出

`<name>/SKILL.md` **一个文件**,307 字节,LF 换行,无 BOM。全文见 `upstream-init-template.md`。
结构:

```
---
name: <目录名原样>
description: A brief description of what this skill does
---

# <目录名原样>

Instructions for the agent to follow when this skill is activated.

## When to use

Describe when this skill should be used.

## Instructions

1. First step
2. Second step
3. Additional steps as needed
```

## 结论

1. **frontmatter 的 `name` 取目录名原样**,不是另起的显示名;`description` 是英文占位。
2. **只创建 SKILL.md**,不建目录结构、不装到任何 agent、**不写 `.skill-lock.json`**
   ——init 是"起一个新技能的草稿",不是安装。lock 记的是"从哪装来的",新建的没有来源。
3. **目标已存在时拒绝**,原样输出 `Skill already exists at <name>/SKILL.md`,不覆盖。
4. **中文名原样创建中文目录 + 中文 `name`,不做任何 sanitize**。

## 我们有意偏离的地方(第 4 条)

上游会造出**本 app 的 installer 明确拒绝处理**的东西:中文目录名经 `sanitize_name`
会整体折成 `unnamed-skill`,两个中文技能因此装进同一目录互相覆盖,installer 对这种
"信息全丢"的名字报 `FS_UNUSABLE_NAME`(CLAUDE.md 关键事实)。

所以向导**强制 ASCII kebab 的目录名**,显示名(可中文)另填进 frontmatter 的 `name`
——与分享时的中文名策略互为镜像(share.rs 模块头:远端目录名强制 ASCII,
`name` 保持中文显示名)。这是有意的偏离,不是没对齐上游。

正文模板同理改中文:本 app 的用户是非研发中文用户,给一份英文骨架等于让他们先翻译
再动手。结构(标题 / 何时使用 / 步骤)与上游一致,便于两边的技能互相看懂。
