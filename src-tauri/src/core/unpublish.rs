//! 作者把自己的技能从技能库里删掉(0.8.0 任务 5)。
//!
//! 设计在本地 `docs/设计-0.8.0-库里查看·差异拍板·作者删除.md` §3。这是全仓**第二条**
//! 会删远端文件的写路径(第一条是分享的差集删除),所以它照抄分享那条路上已经付过学费的
//! 每一道闸:
//!
//! 1. **作者闸**:只有库根 `authors.json` 登记的作者能删。与 `share_installed` 同一个判据
//!    (`ownership::relation`),作者取自**刚下载的这份压缩包**(此刻库里的事实,零新增请求)。
//!    ⚠️ 与 `share_installed` 有一处**刻意不同**:那边"没登记作者时放行",这里**不放行**
//!    ——删除的后果大得多,"那一刻不知道这不是你的"不足以成为删掉它的理由。
//!    没登记作者的技能交给管理员在技能库网页上处理。
//! 2. **两轮确认绑同一份远端快照**(v8 终审 C1):预览轮回文件清单 + `remote_rev`
//!    (该技能目录的远端内容指纹);确认轮带回来对不上就**不删**,退回新清单让用户重看。
//!    否则确认框打开到点下确认之间同事推的新文件会被一起删掉,而它从没出现在清单上。
//! 3. **一笔提交删干净**:技能目录下全部文件 + `authors.json`/`tags.json`/`curated.json`
//!    里的条目。三份元数据读不到或形状不对就**跳过那一份**(沿用「归因绝不拦分享」),
//!    技能文件本身必须删;元数据导致整笔被拒时剥掉元数据重试一次。
//! 4. **403 报一句人话,不降级开分支**(与 v8 分享口径一致)。
//!
//! 本机那一份默认不动;调用方要求时复用 `remove::remove`(解链 → 进废纸篓 → 清账 →
//! 移除 lock 条目),不另写一条删本地文件的路。**先删库、后删本地**:库删失败就不动本地;
//! 库删成功、本地失败时如实回报,不当成整体失败(库里那件事已经发生了)。
//!
//! 只支持 Gitea 源:公司技能库就是 Gitea,`authors.json` 也是公司库契约
//! (GitHub 源本来就不展示归因)。

use serde::Serialize;

use crate::core::agents::AgentEnv;
use crate::core::gitea::{ChangeFilesRequest, FileChange, GiteaClient, RepoRef, RepoSource};
use crate::core::installer::Installer;
use crate::core::ownership;
use crate::core::share::{self, ShareClient};
use crate::core::state::Store;
use crate::error::AppError;

const AUTHORS_FILE: &str = "authors.json";
const TAGS_FILE: &str = "tags.json";
const CURATED_FILE: &str = "curated.json";

pub struct UnpublishRequest<'a> {
    pub registry_id: &'a str,
    pub repo: &'a RepoRef,
    /// 「我的技能」/详情手上的技能标识(本机查本体的键)。
    pub dir_slug: &'a str,
    /// 技能在库里的真实路径(索引的 `path`),不拿 `skills/<dirSlug>` 现猜。
    pub skill_path: &'a str,
    /// frontmatter `name`:`curated.json` 按它记(见 CLAUDE.md「curated.json 约定」)。
    pub display_name: &'a str,
    /// 确认轮带回来的 `remote_rev`。`None` = 预览轮,方向安全(最多多问一次)。
    pub confirm: Option<&'a str>,
    /// 同时把本机这份移到废纸篓。
    pub also_trash_local: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum UnpublishOutcome {
    /// 要用户先看清再确认。`stale` = 上一轮看过的清单已经过期(库里又变了)。
    NeedsConfirm {
        /// 将删除的文件(相对技能目录),排好序。
        files: Vec<String>,
        remote_rev: String,
        /// 技能目录在库里的提交历史页——"删了还能找回"这句话的落点。
        history_url: String,
        stale: bool,
    },
    Unpublished {
        commit_sha: String,
        local: LocalResult,
    },
}

/// 本机那一份怎么样了。可辨联合,不是布尔:"没要求"与"要求了但失败"是两句不同的话。
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum LocalResult {
    Untouched,
    Trashed,
    Failed { error: AppError },
}

#[allow(clippy::too_many_arguments)]
pub async fn unpublish(
    client: &ShareClient<'_>,
    read: &impl RepoSource,
    installer: &Installer<'_>,
    env: &dyn AgentEnv,
    store: &Store,
    req: UnpublishRequest<'_>,
) -> Result<UnpublishOutcome, AppError> {
    let ShareClient::Gitea(gitea) = client else {
        return Err(AppError::new(
            "REPO_UNSUPPORTED",
            "这个来源的技能库不支持在应用里删除技能,请到它的网页上操作",
        )
        .with_detail(format!("unpublish on non-gitea registry {}", req.registry_id)));
    };
    let skill_path = req.skill_path.trim_matches('/');
    let prefix = format!("{skill_path}/");
    let library_slug = skill_path.rsplit('/').next().unwrap_or(skill_path).to_string();

    // ① 此刻库里的样子(一次下载,作者闸与清单共用)。🔴 **压缩包与下面的删除清单读同一个
    // 提交**(终审 M-8):先取分支头,两处都按它的 sha 读——否则两次读之间被推进来的文件
    // 会进删除清单,却从没出现在用户看过的清单上。
    let head = read.branch_head(req.repo).await?;
    let at_head = RepoRef { branch: head.sha.clone(), ..req.repo.clone() };
    let archive = read.download_archive(&at_head).await?;
    let remote = share::remote_files(&archive, &prefix);
    if remote.is_empty() {
        return Err(AppError::new(
            "REPO_NOT_FOUND",
            "技能库里已经没有这个技能了,刷新一下就能看到",
        )
        .with_detail(format!("{prefix} not in {}/{}", req.repo.owner, req.repo.repo)));
    }

    // ② 作者闸(见模块头:没登记作者也不放行)
    let author = crate::core::store::parse_authors(&archive)
        .get(&library_slug)
        .map(|a| a.author.clone());
    let config = store.load_config()?.value;
    let me = config.identities.get(req.registry_id);
    match author {
        None => {
            return Err(AppError::new(
                "REPO_NOT_AUTHOR",
                "这个技能在技能库里没有登记作者,应用里删不了,请联系技能库管理员在网页上处理",
            )
            .with_detail(format!("no author for {library_slug}")))
        }
        Some(author) => {
            if ownership::relation(me, Some(author.as_str()), true, true) != ownership::Relation::Shared {
                return Err(AppError::new(
                    "REPO_NOT_AUTHOR",
                    format!("这个技能是 {author} 分享的,只有作者本人能从技能库里删除它"),
                )
                .with_detail(format!("author={author}, slug={library_slug}, me={:?}", me.map(|i| &i.login))));
            }
        }
    }

    // ③' 写权限——**排在预览轮之前**(终审 M-3):没有写权限的作者不该先看完清单、
    //     点了确认才被告知删不了。这一步只读(查仓库信息),预览轮仍然零写请求。
    let info = gitea.repo_info(&req.repo.owner, &req.repo.repo).await?;
    if !info.permissions.push {
        return Err(AppError::new(
            "REPO_NO_WRITE_ACCESS",
            "你对这个技能库没有写入权限,删不了。请找管理员开通后再试",
        )
        .with_detail(format!("no push permission on {}/{}", req.repo.owner, req.repo.repo)));
    }

    // ③ 清单 + 快照指纹。两轮绑同一份快照(见模块头 2)
    let mut files: Vec<String> = remote
        .keys()
        .filter_map(|p| p.strip_prefix(prefix.as_str()).map(str::to_string))
        .collect();
    files.sort();
    let rev = share::remote_rev(&archive, skill_path);
    let history_url = gitea.history_url(req.repo, skill_path);
    match req.confirm {
        None => {
            return Ok(UnpublishOutcome::NeedsConfirm { files, remote_rev: rev, history_url, stale: false })
        }
        Some(seen) if seen != rev => {
            return Ok(UnpublishOutcome::NeedsConfirm { files, remote_rev: rev, history_url, stale: true })
        }
        Some(_) => {}
    }

    // ⑤ 删除清单:要每个文件此刻在分支头上的 blob sha(Gitea 拿它做乐观锁)
    let mut changes: Vec<FileChange> = gitea
        .tree_files(&req.repo.owner, &req.repo.repo, &head.sha)
        .await?
        .into_iter()
        .filter(|f| f.path.starts_with(prefix.as_str()))
        .map(|f| FileChange::delete(f.path, f.sha))
        .collect();
    if changes.is_empty() {
        // 快照之后、提交之前被别人删光了:要办的事已经办成,但这里不编造一个提交号
        return Err(AppError::new(
            "REPO_NOT_FOUND",
            "技能库里已经没有这个技能了,刷新一下就能看到",
        )
        .with_detail(format!("{prefix} vanished before commit")));
    }
    let skill_files = changes.len();
    for (file, edit) in [
        (AUTHORS_FILE, MetaEdit::Authors(&library_slug)),
        (TAGS_FILE, MetaEdit::Tags(&library_slug)),
        (CURATED_FILE, MetaEdit::Curated(req.display_name)),
    ] {
        if let Some(fc) = meta_change(gitea, req.repo, file, edit).await {
            changes.push(fc);
        }
    }

    let message = format!("删除技能:{library_slug}");
    let request = ChangeFilesRequest {
        branch: req.repo.branch.clone(),
        new_branch: None,
        message,
        files: changes,
    };
    let commit = match commit_sparing_meta(gitea, req.repo, &request, skill_files).await {
        Ok(c) => c,
        Err(e) if e.code == "REPO_FORBIDDEN" => {
            return Err(AppError::new(
                "REPO_PUSH_BLOCKED",
                "这个技能库开启了保护,现在不能直接删除,请联系它的管理员",
            )
            .with_detail(format!("direct push rejected by {}/{}", req.repo.owner, req.repo.repo)))
        }
        Err(e) => return Err(e),
    };

    // ⑥ 本机那一份(可选,复用移除)。库那边已经成功了,这里的失败只回报不回滚
    let local = if req.also_trash_local {
        match crate::core::remove::remove(installer, env, store, req.dir_slug) {
            Ok(_) => LocalResult::Trashed,
            Err(error) => LocalResult::Failed { error },
        }
    } else {
        // 🔴 本机保留时,把这一行记账的**来源**清掉(0.8.0 任务 7 发现的接缝)。
        // 不清的话,记账仍指向公司库 → `in_builtin_library` 的 `builtin_record` 支照样成立 →
        // 这一行留在「安装自」并被判成"技能库里已经没有它了"、主按钮一个都不给——
        // 作者想改改再分享回去,界面上没有路。清掉来源后它与纯本地技能的空来源账同形
        // (`converge::set_agents` 建的那种),按既有判据落进「可分享到」,分享按钮回来。
        // 同事那边的记账没人动,照样显示"技能库里已经没有它了"——那正是他们该看到的。
        // 失败不回滚库里那一笔(已经发生了),只记日志:最坏是这一行暂时显示"库里没了"。
        if let Err(e) = detach_local_record(installer, store, req.dir_slug, &library_slug, req.registry_id, req.repo) {
            tracing::warn!(code = %e.code, "删除后清理本机记账来源失败");
        }
        LocalResult::Untouched
    };
    Ok(UnpublishOutcome::Unpublished { commit_sha: commit.sha, local })
}

/// 把这个技能本机记账的来源清空(见调用点的注释)。没有记账就什么都不做——**绝不凭空建账**。
fn detach_local_record(
    installer: &Installer<'_>,
    store: &Store,
    dir_slug: &str,
    library_slug: &str,
    registry_id: &str,
    repo: &RepoRef,
) -> Result<(), AppError> {
    let key = crate::core::converge::record_key(installer, dir_slug)?;
    let mut next = store.load_state()?.value;
    // `state.shared` 里那条"分享到这个库"的记账也作废:它的基线指向一个已经删掉的远端版本。
    // 今天 Fresh 那一档不跑覆盖闸、读不到它,但留着就是一条迟早误导人的脏账(与 `remove` 同款清理)。
    let before = next.shared.len();
    next.shared
        .retain(|s| !(s.name == library_slug && s.target.owner == repo.owner && s.target.repo == repo.repo));
    let mut changed = next.shared.len() != before;
    if let Some(rec) = next.installed.iter_mut().find(|s| s.name == key) {
        // 🔴 只清**指向被删的那个库**的来源(终审 I-4):同名技能可能装自别的库,
        // 那条记账的更新去处与这次删除毫无关系,清掉它就再也绑不回去。
        if rec.has_source()
            && rec.source.registry_id == registry_id
            && rec.source.owner == repo.owner
            && rec.source.repo == repo.repo
        {
            rec.source.registry_id.clear();
            rec.source.owner.clear();
            rec.source.repo.clear();
            rec.source.path.clear();
            rec.source.git_ref.clear();
            changed = true;
        }
    }
    if next.kept_against.remove(&key).is_some() {
        changed = true;
    }
    if changed {
        store.save_state(&next)?;
    }
    Ok(())
}

/// 提交;被拒(且不是 403)时剥掉元数据重试一次。技能文件是"必须办成"的那部分,
/// 元数据是锦上添花——与 `share::change_files_sparing_skill` 同一个取舍。
async fn commit_sparing_meta(
    client: &GiteaClient,
    repo: &RepoRef,
    req: &ChangeFilesRequest,
    skill_files: usize,
) -> Result<crate::core::gitea::CommitResult, AppError> {
    match client.change_files(&repo.owner, &repo.repo, req).await {
        Ok(c) => Ok(c),
        Err(e) if e.code == "REPO_FORBIDDEN" => Err(e),
        Err(e) if req.files.len() == skill_files => Err(e), // 本来就没带元数据
        Err(e) => {
            tracing::warn!(code = %e.code, "带元数据的删除提交被拒,剥掉元数据重试一次");
            let stripped = ChangeFilesRequest { files: req.files[..skill_files].to_vec(), ..req.clone() };
            client.change_files(&repo.owner, &repo.repo, &stripped).await
        }
    }
}

#[derive(Clone, Copy)]
enum MetaEdit<'a> {
    Authors(&'a str),
    Tags(&'a str),
    Curated(&'a str),
}

async fn meta_change(client: &GiteaClient, repo: &RepoRef, file: &str, edit: MetaEdit<'_>) -> Option<FileChange> {
    let (sha, bytes) = match client.file_content(repo, file).await {
        Ok(Some(v)) => v,
        Ok(None) => return None, // 库里没有这个文件,没东西可清
        Err(e) => {
            tracing::warn!(file, code = %e.code, "读不到元数据文件,本次跳过清理");
            return None;
        }
    };
    let Ok(text) = std::str::from_utf8(&bytes) else {
        tracing::warn!(file, "元数据文件不是 UTF-8,不动它");
        return None;
    };
    let next = match edit {
        MetaEdit::Authors(slug) => remove_object_key(text, "authors", slug),
        MetaEdit::Tags(slug) => remove_object_key(text, "tags", slug),
        MetaEdit::Curated(name) => remove_array_item(text, "curated", name),
    };
    next.map(|t| FileChange::update(file, t.as_bytes(), sha))
}

/// 从 `{"<top>": {"<key>": …}}` 里删掉一个键。返回 `None` = 不用改或形状不对(一个字节都不动)。
///
/// serde_json 开着 `preserve_order`,其余条目与键序原样保住;输出格式与分享维护
/// authors.json 时一致(两空格缩进 + 末尾换行)。
pub(crate) fn remove_object_key(text: &str, top: &str, key: &str) -> Option<String> {
    let mut doc: serde_json::Value = serde_json::from_str(text).ok()?;
    let map = doc.get_mut(top)?.as_object_mut()?;
    map.remove(key)?;
    serde_json::to_string_pretty(&doc).ok().map(|s| s + "\n")
}

/// 从 `{"<top>": ["…", …]}` 里删掉等于 `item` 的那些项。不用改或形状不对 → `None`。
pub(crate) fn remove_array_item(text: &str, top: &str, item: &str) -> Option<String> {
    let mut doc: serde_json::Value = serde_json::from_str(text).ok()?;
    let arr = doc.get_mut(top)?.as_array_mut()?;
    let before = arr.len();
    arr.retain(|v| v.as_str() != Some(item));
    if arr.len() == before {
        return None;
    }
    serde_json::to_string_pretty(&doc).ok().map(|s| s + "\n")
}

#[cfg(test)]
mod tests {
    use super::{remove_array_item, remove_object_key, LocalResult, UnpublishOutcome};
    use crate::error::AppError;

    fn keys(v: &serde_json::Value) -> Vec<String> {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    }

    /// 前端按这些键写类型(`src/lib/ipc.ts::UnpublishOutcome`)。**断言完整键集合**:
    /// 只查"某个键存在"分不出字段被省略还是被拼错(`rename_all_fields` 当年炸过)。
    #[test]
    fn unpublish_outcome_serializes_every_field_in_camel_case() {
        let confirm = serde_json::to_value(UnpublishOutcome::NeedsConfirm {
            files: vec!["SKILL.md".into()],
            remote_rev: "r".into(),
            history_url: "h".into(),
            stale: false,
        })
        .unwrap();
        assert_eq!(keys(&confirm), ["files", "historyUrl", "outcome", "remoteRev", "stale"]);
        assert_eq!(confirm["outcome"], "needsConfirm");

        let done = serde_json::to_value(UnpublishOutcome::Unpublished {
            commit_sha: "c".into(),
            local: LocalResult::Failed { error: AppError::new("FS_X", "说明") },
        })
        .unwrap();
        assert_eq!(keys(&done), ["commitSha", "local", "outcome"]);
        assert_eq!(done["outcome"], "unpublished");
        assert_eq!(keys(&done["local"]), ["error", "kind"]);
        assert_eq!(done["local"]["kind"], "failed");
        for (v, kind) in [(LocalResult::Untouched, "untouched"), (LocalResult::Trashed, "trashed")] {
            let j = serde_json::to_value(v).unwrap();
            assert_eq!(keys(&j), ["kind"]);
            assert_eq!(j["kind"], kind);
        }
    }

    #[test]
    fn removes_only_the_named_key_and_keeps_the_rest_in_order() {
        let text = r#"{"authors":{"b":{"author":"李四"},"a":{"author":"张三"},"c":{"author":"王五"}}}"#;
        let out = remove_object_key(text, "authors", "a").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let keys: Vec<&str> = v["authors"].as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["b", "c"], "其余条目与键序原样保住");
        assert!(out.ends_with('\n'));
    }

    #[test]
    fn leaves_the_file_alone_when_the_key_is_absent_or_the_shape_is_wrong() {
        assert_eq!(remove_object_key(r#"{"tags":{"x":["a"]}}"#, "tags", "y"), None);
        assert_eq!(remove_object_key(r#"{"tags":["a"]}"#, "tags", "x"), None, "形状不对不动");
        assert_eq!(remove_object_key("不是 JSON", "tags", "x"), None);
    }

    #[test]
    fn removes_the_curated_entry_by_name() {
        let out = remove_array_item(r#"{"curated":["周报生成","代码注释向导"]}"#, "curated", "周报生成").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["curated"], serde_json::json!(["代码注释向导"]));
        assert_eq!(remove_array_item(r#"{"curated":["x"]}"#, "curated", "y"), None);
    }
}
