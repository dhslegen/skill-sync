// 视觉走查 harness 的**唯一一份**假数据来源(v7.1 任务 2)。
//
// # 为什么全部挤在一个模块里
//
// 「我的技能」一行摆哪颗按钮,是 `installed_list`(记账)与 `store_index`(库里
// 那一版的指纹)两份数据**互相比对**的结果(`store/my-skills.ts::hasUpdate` →
// `lib/ownership.ts::rowAction`)。两份数据分开手写,只要有一处 dirSlug 拼错、
// 或 registryId/owner/repo 对不上,那一行就会静默退回「没有更新」——截图看着
// 像界面缺陷,其实是 fixture 自己不自洽。所以这里从**一张技能表**派生出两侧,
// 让一致性是结构性的,而不是靠人抄对。
//
// # 名字取自设计画布
//
// 技能名、描述、分区归属逐条抄自 `Main.dc.html`(v7.1 设计画布),这样截图能与
// 画布逐项对照。**注意**:core 的 `InstalledSkillView` 里**没有** name/description
// 字段,界面上的中文名来自技能库索引(`cardOf`)——所以纯本地草稿那三行在真实
// 界面上显示的就是 dirSlug、且不摆描述。这是现状(Q7B 拍板"行上名字维持现状"),
// 不是 fixture 漏填,别"顺手补上"。

/** 公司技能库的坐标。`registryId` 与 `store/store-index.ts` 的默认 activeRegistry 一致。 */
const COMPANY = { registryId: "company", owner: "skills", repo: "skills" };
/** 「可分享到」区那一行的外部来源(广场),用来演示"外源有新版"。 */
const PLAZA = { registryId: "plaza", owner: "vercel-labs", repo: "agent-skills" };

const CANONICAL = "/Users/demo/.agents/skills";
const CLAUDE_DIR = "/Users/demo/.claude/skills";

/** 这台电脑上探测到的工具。`tools[].agent` 必须能在这里查到展示名,
 *  否则界面会露出 `claude-code` 这类内部标识(本项目记录过的缺陷类别)。 */
const AGENTS = [
  { name: "claude-code", displayName: "Claude Code", dir: "/Users/demo/.claude/skills", universal: false, needsLink: true },
  { name: "trae", displayName: "Trae", dir: "/Users/demo/.trae/skills", universal: false, needsLink: true },
  { name: "cursor", displayName: "Cursor", dir: CANONICAL, universal: true, needsLink: false },
  { name: "codex", displayName: "Codex", dir: CANONICAL, universal: true, needsLink: false },
  { name: "cline", displayName: "Cline", dir: CANONICAL, universal: true, needsLink: false },
  { name: "zed", displayName: "Zed", dir: CANONICAL, universal: true, needsLink: false },
];

/** 统一目录里那份本体会被哪几个工具读到(v7.1 任务 1 的 canonicalReaders)。 */
const CANONICAL_READERS = ["Cline", "Cursor", "Codex", "Zed"];

/**
 * 一张技能表 = 截图里该出现的十二行。
 *
 * - `section` 决定落在哪一区;`relation` 与它一一对应(core 侧
 *   `ownership::section(relation)`:installed→installedFrom / shared→sharedTo /
 *   draft→shareable),两者必须成对改,否则 core 的口径就被 fixture 说谎了。
 * - `remote` = 库里那一版的指纹。与 `contentHash`(安装基线)不同 → 「有更新」。
 * - `localModified` = 本地改过基线。两者同时为真 → `conflict`(库里有新版…)。
 */
const SKILLS = [
  // ---------------------------------------------------------------- 安装自技能库
  {
    slug: "api-test-expert",
    name: "接口测试专家",
    description: "设计接口测试用例并执行接口测试,输出测试文档。",
    tags: ["测试", "文档"],
    section: "installedFrom",
    body: `${CANONICAL}/api-test-expert`,
    contentHash: "h-api-1",
    remote: "h-api-2", // 库里更新了 → 「更新」
    localModified: false,
    tools: [{ agent: "claude-code", state: "linked" }, { agent: "trae", state: "off" }],
    canonicalReaders: CANONICAL_READERS,
  },
  {
    slug: "code-annotator",
    name: "代码注释向导",
    description: "为新接手的代码批量添加详细中文注释,让代码像读母语文章一样流畅。",
    tags: ["代码", "阅读"],
    section: "installedFrom",
    body: `${CLAUDE_DIR}/code-annotator`, // 本体住在工具目录里(v6 二期的旗舰场景)
    contentHash: "h-anno-1",
    remote: "h-anno-2",
    localModified: true, // 库新 + 本地改 → `conflict`「库里有新版…」
    tools: [{ agent: "claude-code", state: "body" }, { agent: "trae", state: "linked" }],
    canonicalReaders: null, // 本体不在统一目录 → 恒 null
  },
  {
    slug: "chinese-word-document",
    name: "中文 Word 文档规范",
    description: "标题样式、中西文字体、页脚仅页码、标点自检。",
    section: "installedFrom",
    body: `${CANONICAL}/chinese-word-document`,
    contentHash: "h-word-1",
    remote: "h-word-1", // 库里没变
    localModified: true, // 只有本地改 → 「贡献更改」
    tools: [{ agent: "claude-code", state: "linked" }],
    canonicalReaders: CANONICAL_READERS,
  },
  {
    slug: "docx-to-markdown",
    name: "Word 转 Markdown",
    description: "手工迁移与校准,保留标题编号、合并单元格与续表。",
    section: "installedFrom",
    body: `${CANONICAL}/docx-to-markdown`,
    contentHash: "h-docx-1",
    remote: "h-docx-1",
    localModified: false, // 没有例外 → 无主按钮
    tools: [{ agent: "claude-code", state: "linked" }],
    canonicalReaders: CANONICAL_READERS,
  },
  {
    slug: "project-onboarding",
    name: "项目快速上手",
    description: "深度分析代码库,生成九部分结构化上手文档。",
    section: "installedFrom",
    body: `${CANONICAL}/project-onboarding`,
    contentHash: "h-onb-1",
    remote: "h-onb-1",
    localModified: false,
    tools: [{ agent: "claude-code", state: "linked" }, { agent: "trae", state: "linked" }],
    canonicalReaders: CANONICAL_READERS,
  },
  {
    slug: "weekly-report",
    name: "周报生成",
    description: "根据随笔与代码改动记录,生成面向领导的每周工作汇报。",
    section: "installedFrom",
    body: `${CANONICAL}/weekly-report`,
    contentHash: "h-week-1",
    remote: "h-week-1",
    localModified: false,
    tools: [{ agent: "claude-code", state: "linked" }],
    canonicalReaders: CANONICAL_READERS,
  },
  // -------------------------------------------------------------- 已分享到技能库
  {
    slug: "rcs-generator",
    name: "接口脚本生成",
    description: "把需求文档转换成标准化的 .rcs 接口脚本。",
    section: "sharedTo",
    body: `${CLAUDE_DIR}/rcs-generator`,
    contentHash: "h-rcs-1",
    remote: "h-rcs-1",
    localModified: true, // 我分享的 + 本地改 → 「分享改动」
    tools: [{ agent: "claude-code", state: "body" }, { agent: "trae", state: "linked" }],
    canonicalReaders: null,
  },
  {
    slug: "base-code-gen",
    name: "数据库逆向生成",
    description: "连接 MySQL / PostgreSQL 扫描表结构,生成 MyBatis-Plus 分层代码。",
    section: "sharedTo",
    body: `${CANONICAL}/base-code-gen`,
    contentHash: "h-base-1",
    remote: "h-base-1",
    localModified: false,
    tools: [{ agent: "claude-code", state: "linked" }],
    canonicalReaders: CANONICAL_READERS,
  },
  // -------------------------------------------------------------- 可分享到技能库
  {
    slug: "excalidraw-diagram-generator",
    name: "Excalidraw 图表",
    description: "用自然语言描述生成流程图、架构图与思维导图。",
    section: "shareable",
    body: `${CANONICAL}/excalidraw-diagram-generator`,
    contentHash: "",
    remote: null, // 不在公司库里
    localModified: false,
    tools: [{ agent: "claude-code", state: "linked" }],
    canonicalReaders: CANONICAL_READERS,
  },
  {
    slug: "react-best-practices",
    name: "React 最佳实践",
    description: "Vercel 出品的 React / Next.js 性能与写法指南。",
    section: "shareable",
    // 有外部来源 → 「…」里能查到它自己那个源的索引(点开这一行才会发请求)
    source: PLAZA,
    sourceLabel: "vercel-labs/agent-skills",
    body: `${CANONICAL}/react-best-practices`,
    contentHash: "h-react-1",
    remote: null,
    externalRemote: "h-react-2", // 外源有新版 → 「更新」
    localModified: false,
    tools: [{ agent: "claude-code", state: "linked" }],
    canonicalReaders: CANONICAL_READERS,
  },
  {
    slug: "polyglot-from-java",
    name: "从 Java 出发学新语言",
    description: "以老兵视角打碎 Java 思维定式,层级式拆解目标语言。",
    section: "shareable",
    body: `${CLAUDE_DIR}/polyglot-from-java`,
    contentHash: "",
    remote: null,
    localModified: false,
    // 标准校验没过:SKILL.md 里的 name 与文件夹名不一致
    shareBlocked: "nameMismatch",
    tools: [{ agent: "claude-code", state: "body" }],
    canonicalReaders: null,
  },
  {
    slug: "riso-editorial-deck",
    name: "Riso 印刷风幻灯片",
    description: "暖纸底、双色叠印、代码生成墨流场的 PPTX 生成。",
    section: "shareable",
    body: `${CANONICAL}/riso-editorial-deck`,
    contentHash: "",
    remote: null,
    localModified: false,
    // 「审核中」:core 查到这一行挂着一条开放的合并请求
    review: { url: "http://gitea.internal.example/skills/skills/pulls/42" },
    tools: [{ agent: "claude-code", state: "linked" }],
    canonicalReaders: CANONICAL_READERS,
  },
  {
    // v7.2 需求 4:第三个来源组——按来源分组要看得出"不止一个外部来源"
    slug: "md-translator",
    name: "Markdown 汉化",
    description: "语义感知地把英文 Markdown 译成中文,保留代码块与链接。",
    section: "shareable",
    source: PLAZA,
    sourceLabel: "acme/skills-lab",
    body: `${CANONICAL}/md-translator`,
    contentHash: "h-md-1",
    remote: null,
    externalRemote: "h-md-1", // 与本地一致 → 没有更新,主按钮是「分享」
    localModified: false,
    tools: [{ agent: "claude-code", state: "linked" }],
    canonicalReaders: CANONICAL_READERS,
  },
  // ------------------------------------------------ 库里有、这台电脑还没装(终审 I-2)
  // 🔴 `notInstalled` 让它**不进** `installed_list`,只进公司库索引——商店卡片
  // 因此是「获取」而不是「已启用」,才走得到 `AgentChooser`(选工具)与
  // `ConfirmBar`(装到项目确认条)这两屏。这两屏正是终审 I-2 要看的东西:
  // 共享常量 `LIST_ROW_EXTRA` 改动后,只有这两个调用方把 picker 包在带边框的
  // 盒子里,截图之外没有任何环节看得见它们。
  {
    slug: "security-review",
    name: "安全评审清单",
    description: "按威胁建模逐项过一遍改动,输出可执行的复查清单。",
    tags: ["安全", "评审"],
    notInstalled: true,
    section: "installedFrom",
    body: `${CANONICAL}/security-review`,
    contentHash: "h-sec-1",
    remote: "h-sec-1",
    localModified: false,
    tools: [{ agent: "claude-code", state: "linked" }],
    canonicalReaders: CANONICAL_READERS,
  },
];

const RELATION_OF = {
  installedFrom: "installed",
  sharedTo: "shared",
  shareable: "draft",
};

/** 一份足够长的 SKILL.md,详情面板才会真的出现滚动条(截图 3 的前提)。 */
function skillMd(name, description) {
  const paragraphs = [
    `# ${name}`,
    "",
    `> ${description}`,
    "",
    "## 什么时候用它",
    "",
    "当你需要把一份零散的输入整理成结构化的产物时,先读这一节。它不替你做决定,",
    "只把你已经知道的事情摆成一张能一眼看完的表。",
    "",
    "## 步骤",
    "",
    "1. 先确认输入是完整的:缺一段就停下来问,不要猜。",
    "2. 按下面的模板逐项填写,填不出来的项留空并写明原因。",
    "3. 产出交给使用者过目,拿到明确的「可以」再进下一步。",
    "",
    "## 模板",
    "",
    "```markdown",
    "## 标题",
    "",
    "- 背景:",
    "- 结论:",
    "- 依据:",
    "- 待确认:",
    "```",
    "",
    "## 常见误区",
    "",
    "- **把假设写成事实**:没有实测过的结论要标明它是假设。",
    "- **范围声称大于实际**:说「全量扫描过」之前,先确认扫描器本身是对的。",
    "- **只报好消息**:失败与跳过同样要如实回报,不能画成「全部成功」。",
    "",
    "## 附注",
    "",
    "这一段刻意写得长一点,是为了让详情面板出现纵向滚动条——视觉走查要看的",
    "正文与固定页脚之间的关系,只有在真的能滚起来的时候才看得出来。",
    "",
    "更多说明见团队内网文档。以上内容为视觉走查用的示例数据,不代表真实技能。",
  ];
  return paragraphs.join("\n");
}

function installedSkill(s) {
  const source = s.source ?? (s.remote === null && !s.source ? { registryId: "", owner: "", repo: "" } : COMPANY);
  return {
    dirSlug: s.slug,
    commitSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f001234567",
    contentHash: s.contentHash ?? "",
    agents: s.tools.filter((t) => t.state !== "off").map((t) => t.agent),
    installedAt: "2026-08-12T09:20:00Z",
    updatedAt: "2026-08-28T14:05:00Z",
    localModified: !!s.localModified,
    sourceOwner: source.owner,
    sourceRepo: source.repo,
    registryId: source.registryId,
    sourceRemoved: false,
    libraryRemoved: false,
    relation: RELATION_OF[s.section],
    localPresent: true,
    sourceLabel: s.sourceLabel ?? (source.owner ? `${source.owner}/${source.repo}` : null),
    body: s.body,
    localHash: s.localModified ? `${s.contentHash || "h"}-dirty` : s.contentHash || "h-local",
    tools: s.tools,
    versions: [],
    shareBlocked: s.shareBlocked ?? null,
    section: s.section,
    review: s.review ?? null,
    // 「在技能库里查看」的地址由 core 拼(编译期内网地址 + 索引里的真实 path);
    // 只有确实在公司技能库里的行才有值。这里照那个形状造。
    libraryUrl:
      s.section === "shareable"
        ? null
        : `http://gitea.internal.example/skills/skills/src/branch/main/skills/${s.slug}`,
    canonicalReaders: s.canonicalReaders ?? null,
  };
}

function card(s, hash) {
  return {
    name: s.name,
    dirSlug: s.slug,
    description: s.description,
    path: `skills/${s.slug}`,
    hasScripts: false,
    fileCount: 3,
    contentHash: hash,
    tags: s.tags ?? [],
    author: s.section === "sharedTo" ? "赵文浩" : "李明",
  };
}

function indexView(coords, skills) {
  return {
    registryId: coords.registryId,
    owner: coords.owner,
    repo: coords.repo,
    branch: "main",
    commitSha: "9a8b7c6d5e4f30291827364554637281900abcde",
    committedAt: "2026-09-01T02:11:00Z",
    fetchedAt: Date.now(),
    skills,
    skipped: [],
    fromCache: false,
    offline: false,
    curated: [],
  };
}

/** 组装出注入进页面的那份数据。**纯 JSON**,会被 `addInitScript` 序列化过去。 */
export function buildFixtures() {
  const companyCards = SKILLS.filter((s) => s.remote !== null).map((s) => card(s, s.remote));
  const plazaCards = SKILLS.filter((s) => s.externalRemote).map((s) => card(s, s.externalRemote));

  const indexes = {
    "company::skills/skills": indexView(COMPANY, companyCards),
    "plaza::vercel-labs/agent-skills": indexView(PLAZA, plazaCards),
  };

  // 商店详情(`store_skill_detail`)。与本地详情同一份数据派生,别手写第二份
  // ——两份分叉时截图会安静地显示一个与索引对不上的技能。
  const storeDetails = {};
  for (const s of SKILLS) {
    storeDetails[s.slug] = {
      name: s.name,
      dirSlug: s.slug,
      description: s.description,
      path: `skills/${s.slug}`,
      skillMd: skillMd(s.name, s.description),
      files: [
        { path: "SKILL.md", size: 4210 },
        { path: "reference/template.md", size: 1180 },
      ],
      hasScripts: false,
      commitSha: "9a8b7c6d5e4f30291827364554637281900abcde",
      committedAt: "2026-09-01T02:11:00Z",
      tags: s.tags ?? [],
      attribution: null,
    };
  }

  const localDetails = {};
  for (const s of SKILLS) {
    localDetails[s.body] = {
      name: s.name,
      dirSlug: s.slug,
      description: s.description,
      path: s.body,
      skillMd: skillMd(s.name, s.description),
      files: [
        { path: "SKILL.md", size: 4210 },
        { path: "reference/template.md", size: 1180 },
        { path: "reference/examples.md", size: 2640 },
      ],
      hasScripts: false,
    };
  }

  return {
    // 截图脚本要按名字点行,所以把这张表也带过去(只读,页面不用)
    roster: SKILLS.map((s) => ({ slug: s.slug, name: s.name, section: s.section })),
    indexes,
    storeDetails,
    localDetails,
    defaultIndexKey: "company::skills/skills",
    responses: {
      app_info: { version: "0.6.0", builtinConfigured: true },
      ui_prefs_get: { theme: "light", accent: "clay", wizardDone: true },
      ui_prefs_set: null,
      auth_status: {
        loggedIn: true,
        user: { login: "zhaowenhao", displayName: "赵文浩", avatarUrl: "" },
      },
      installed_list: SKILLS.filter((s) => !s.notInstalled).map(installedSkill),
      agents_detected: {
        canonicalDir: CANONICAL,
        agents: AGENTS.map((a) => ({
          name: a.name,
          displayName: a.displayName,
          installed: true,
          globalSkillsDir: a.dir,
          isUniversal: a.universal,
          needsLink: a.needsLink,
          disabled: false,
        })),
      },
      registry_list: [
        {
          id: "company",
          name: "公司技能库",
          kind: "gitea",
          baseUrl: "http://gitea.internal.example",
          builtin: true,
          repo: { owner: "skills", repo: "skills", branch: "main" },
          repos: [
            { key: "skills/skills", owner: "skills", repo: "skills", branch: "main", name: null, primary: true, locked: true },
          ],
        },
        {
          id: "plaza",
          name: "技能广场",
          kind: "github",
          baseUrl: "https://github.com",
          builtin: false,
          repo: null,
          repos: [],
        },
      ],
      // 更新日志卡片:pending 为空 = 不显示(否则它会盖在商店页顶部)
      release_notes_state: { current: "0.6.0", pending: [], all: [] },
      release_notes_ack: null,
      project_list: [],
      // 「装到项目…」→ 系统选择框。harness 里直接给一个路径,
      // `useProjects.requestInstall` 据此摆出确认条(终审 I-2 的第二屏)。
      project_pick: "/Users/demo/Developer/company/erp-backend",
      auto_update_get: { skills: { enabled: true, intervalMinutes: 240 }, app: true },
      update_check_now: null,
      app_update_check: { status: "upToDate" },
      plaza_leaderboard: [],
      plaza_search: [],
    },
  };
}
