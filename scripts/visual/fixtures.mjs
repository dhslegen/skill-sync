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
    updatedAt: { kind: "longAgo" },
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
    updatedAt: { kind: "unknown" },
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

// ---------------------------------------------------------------- 项目里的技能
/**
 * 「项目里的技能」页的数据(0.6.x 填 harness 空洞:此前 `project_list: []`,
 * 那一整页从 v7 任务 8 起**永远渲染空态**,v7.6 的项目行菜单、v7.7 的 portal
 * 浮层在这一页都从未被截图验证过——而每一轮"截图全部产出"都成立,空页也能截)。
 *
 * 一张表派生出 `project_list`,派生规则照 core(`commands.rs::ProjectSkillView`
 * 与 `project::update_target`),**不手填**会与 core 口径分叉的字段:
 * - `folderName` 取 `path` 末段;
 * - `updatable` = 推得出 `dirSlug` **且** 还原得出 `registryId`,差一样都不摆
 *   「更新」;
 * - `sourceType` 照 `project_skill_install` 写 lock 的口径:Gitea 来源写 `git`
 *   (**不是** `gitea`——`RESTORABLE_SOURCE_TYPES` 里没有 `gitea`,写成它就是
 *   把公司库技能全判成不可更新的假图),GitHub 来源写 `github`;
 * - `agents` 是这个技能在**这个项目里**眼下实际链到的工具(内部名),事后改选
 *   picker 初始勾选的唯一来源。universal 工具(cursor/codex…)在项目级本来就
 *   不建链(`link_dirs` 跳过),所以这里只出现 claude-code / trae。
 *
 * 🔴 **与 09 屏的隐性耦合**:`project_pick` 返回 erp-backend 的路径,而
 * `useProjects.requestInstall` 按 `dirSlug` 在同一路径的项目里判 `alreadyInstalled`。
 * `security-review` **不能**放进 erp-backend——放了 09 屏的「装到这里」会变成
 * 「覆盖重装」,`waitFor` 直接红。走查清单 F4「覆盖重装」另有一屏
 * (`29-install-project-confirm-reinstall`),用的是已在 erp-backend 里的「周报生成」。
 *
 * 🔴 **公司库那几行刻意避开 02–07 屏在用的技能**(code-annotator / api-test-expert):
 * 详情面板「项目里」块(`WhereBlocks::ProjectsBlock`)按 `dirSlug` 从
 * `project_list` 派生,fixture 有数据之后那一块**第一次**会出现——摆进那两个
 * 技能会让「在哪」既有几屏一起变样、失去与旧图的可比性。那一块由
 * `28-detail-projects-block` 用「周报生成」单独截。
 *
 * ⚠️ 这里没有"已关联但这台机器没探测到的工具"这一档(`agentNames.get(a) ?? a`
 * 那条路):真 core 的 `agents_detected` 返回整份注册表(75 个,含未安装的),
 * 展示名总能解析;而 harness 的 `AGENTS` 只有 6 个,塞一个表外的 agent 名,
 * 界面会露出原始 id——那是 fixture 伪影,不是产品发现,别把它截进送审图。
 */
const ERP = "/Users/demo/Developer/company/erp-backend";
const PROJECTS = [
  {
    path: ERP,
    skills: [
      // 公司库的技能(Gitea 源)。dirSlug 与 key 相同——公司库 20 个技能全是 kebab-case
      { key: "weekly-report", displayName: "周报生成", description: "根据随笔与代码改动记录,生成面向领导的每周工作汇报。",
        source: "skills/skills", sourceType: "git", dirSlug: "weekly-report", registryId: "company", repo: "skills/skills",
        agents: ["claude-code", "trae"] },
      { key: "project-onboarding", displayName: "项目快速上手", description: "深度分析代码库,生成九部分结构化上手文档。",
        source: "skills/skills", sourceType: "git", dirSlug: "project-onboarding", registryId: "company", repo: "skills/skills",
        agents: ["claude-code"] },
      // 广场技能:key(frontmatter name)≠ dirSlug(仓库目录名)——项目级安装键跟上游取 name,
      // 「更新」与「项目里」块的匹配都必须走 dirSlug,这一行就是那 8/47 的代表
      { key: "vercel-react-best-practices", displayName: "vercel-react-best-practices",
        description: "React and Next.js performance optimization guidelines from Vercel.",
        source: "vercel-labs/agent-skills", sourceType: "github", dirSlug: "react-best-practices",
        registryId: "plaza", repo: "vercel-labs/agent-skills", agents: ["claude-code"] },
      { key: "pdf", displayName: "pdf", description: "Read, create, and edit PDF files: extract text, fill forms, merge documents.",
        source: "anthropics/skills", sourceType: "github", dirSlug: "pdf", registryId: "plaza", repo: "anthropics/skills",
        agents: ["claude-code", "trae"] },
      // 描述为空 → 行的第二行退回「来自 {library}」那句
      { key: "internal-conventions", displayName: "内部约定", description: "",
        source: "skills/skills", sourceType: "git", dirSlug: "internal-conventions", registryId: "company", repo: "skills/skills",
        agents: ["trae"] },
      // 本地来源(`npx skills add ./path` 装的):还原不出远端 → dirSlug null,不摆「更新」
      { key: "team-glossary", displayName: "团队术语表", description: "本团队的领域词表与命名约定,回答时优先用这里的叫法。",
        source: "./.skills-src/team-glossary", sourceType: "local", dirSlug: null, registryId: null, repo: null,
        agents: ["claude-code"] },
      // well-known 来源(域名):同样不可更新
      { key: "company-style", displayName: "公司文风", description: "对外文案的语气、称谓与禁用词。",
        source: "skills.example.com", sourceType: "well-known", dirSlug: null, registryId: null, repo: null,
        agents: ["claude-code"] },
    ],
  },
  // 目录不在了:core 保证 `skills` 必为空,界面只给「从列表移除」
  { path: "/Users/demo/Developer/archive/old-crm", missing: true, skills: [] },
  // lock 版本不认识 → 只读展示
  { path: "/Users/demo/Developer/company/data-pipeline", readOnly: true, skills: [] },
  // 碰过、但还没装任何技能的项目
  { path: "/Users/demo/Developer/company/docs-site", skills: [] },
  // 🔴 排最后是刻意的:24/25 两屏要点的是**整页最底下那一行**(用户 v7.7 报告的
  // 原操作),它下面只能剩页面的 padding——中间夹着别的分组的话,那一行离视口
  // 底边还有一两百像素,菜单往下开绰绰有余,"贴着底边会不会画出视口"就没测到。
  // erp-backend 不能挪到这里:`recentProjects` 取的是前几个,29 屏要在「最近的
  // 项目」里点到它。
  {
    path: "/Users/demo/Developer/personal/blog",
    skills: [
      { key: "md-translator", displayName: "Markdown 汉化", description: "语义感知地把英文 Markdown 译成中文,保留代码块与链接。",
        source: "acme/skills-lab", sourceType: "github", dirSlug: "md-translator", registryId: "plaza", repo: "acme/skills-lab",
        agents: ["claude-code"] },
    ],
  },
];

function projectSkill(s) {
  return {
    key: s.key,
    displayName: s.displayName,
    description: s.description,
    source: s.source,
    sourceType: s.sourceType,
    dirSlug: s.dirSlug,
    registryId: s.registryId,
    repo: s.repo,
    updatable: s.dirSlug !== null && s.registryId !== null,
    agents: s.agents,
  };
}

function projectGroup(p) {
  return {
    path: p.path,
    folderName: p.path.split("/").pop(),
    missing: !!p.missing,
    readOnly: !!p.readOnly,
    skills: p.skills.map(projectSkill),
  };
}

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
    // v8 任务 1:逐技能的最后改动时间。三档都要有样本——只喂 `at` 的话,
    // 「很久以前」与「整行不摆」两条降级路在截图里一次都不会出现。
    updatedAt: s.updatedAt ?? { kind: "at", at: "2026-09-14T03:12:00Z" },
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
      updatedAt: s.updatedAt ?? { kind: "at", at: "2026-09-14T03:12:00Z" },
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
          // 相对项目根的目录(0.6.x K3):项目行 picker 用它拼落点,26 屏第一次带路径
          skillsDir: a.dir.replace("/Users/demo/", ""),
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
      // 曾经是 `[]`(v7.7 复审登记的覆盖空洞:整页永远空态、从未被截图验证过),
      // 0.6.x 起从上面的 `PROJECTS` 表派生。数据里放了哪些档、为什么避开某些技能,
      // 见那张表头上的说明。
      project_list: PROJECTS.map(projectGroup),
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
