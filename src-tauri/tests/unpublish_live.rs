//! 作者删除库里技能的真 Gitea 端到端(0.8.0 任务 5)。docker fixture 起着才跑。
//!
//! 写远端的用例**只在 docker fixture 测试库上跑**,绝不碰公司技能库。
//! 跳过判据与 `share_live` 同款:`fixtures/.env.local` 不在就早退(早退照样计 ok,
//! 那种"通过"零信息量——见 CLAUDE.md「默认跳过的 live 测试」)。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::fsops;
use skillsync_lib::core::gitea::{FileChange, ChangeFilesRequest, GiteaClient, RepoRef};
use skillsync_lib::core::installer::Installer;
use skillsync_lib::core::ownership::Identity;
use skillsync_lib::core::share::ShareClient;
use skillsync_lib::core::state::{Config, Store};
use skillsync_lib::core::unpublish::{unpublish, UnpublishOutcome, UnpublishRequest};

struct TmpEnv {
    home: PathBuf,
}

impl AgentEnv for TmpEnv {
    fn home(&self) -> Option<PathBuf> {
        Some(self.home.clone())
    }
    fn var(&self, _: &str) -> Option<String> {
        None
    }
    fn path_exists(&self, path: &Path) -> bool {
        path.exists()
    }
    fn read_to_string(&self, path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }
}

fn fixture_env() -> Option<HashMap<String, String>> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).parent()?.join("fixtures/.env.local");
    let text = std::fs::read_to_string(path).ok()?;
    Some(
        text.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .filter_map(|l| l.split_once('=').map(|(k, v)| (k.trim().to_string(), v.trim().to_string())))
            .collect(),
    )
}

#[tokio::test]
async fn an_author_deletes_their_skill_from_a_real_gitea() {
    let Some(vars) = fixture_env() else {
        eprintln!("跳过:未找到 fixtures/.env.local,先跑 ./fixtures/init.sh");
        return;
    };
    let need = ["SKILLSYNC_FIXTURE_GITEA_URL", "SKILLSYNC_FIXTURE_ORG", "SKILLSYNC_FIXTURE_REPO", "SKILLSYNC_FIXTURE_ADMIN_TOKEN", "SKILLSYNC_FIXTURE_ADMIN_USER"];
    if let Some(missing) = need.iter().find(|k| !vars.contains_key(**k)) {
        eprintln!("跳过:fixtures/.env.local 缺 {missing}");
        return;
    }
    let repo = RepoRef {
        owner: vars["SKILLSYNC_FIXTURE_ORG"].clone(),
        repo: vars["SKILLSYNC_FIXTURE_REPO"].clone(),
        branch: "main".into(),
    };
    let admin = GiteaClient::new(vars["SKILLSYNC_FIXTURE_GITEA_URL"].clone(), Some(vars["SKILLSYNC_FIXTURE_ADMIN_TOKEN"].clone())).unwrap();
    if admin.branch_head(&repo).await.is_err() {
        eprintln!("跳过:连不上 fixture Gitea");
        return;
    }
    let me = vars["SKILLSYNC_FIXTURE_ADMIN_USER"].clone();
    let name = format!("unpublish-live-{:x}", std::process::id());
    let skill_path = format!("skills/{name}");

    // ① 以作者身份放一个技能进库,并在 authors.json 里登记作者是自己
    let md = format!("---\nname: {name}\ndescription: 删除实测\n---\n正文\n");
    let mut seed = vec![
        FileChange::create(format!("{skill_path}/SKILL.md"), md.as_bytes()),
        FileChange::create(format!("{skill_path}/ref.md"), "参考\n".as_bytes()),
    ];
    let authors = admin.file_content(&repo, "authors.json").await.unwrap();
    let mut doc: serde_json::Value = match &authors {
        Some((_, bytes)) => serde_json::from_slice(bytes).unwrap(),
        None => serde_json::json!({ "authors": {} }),
    };
    doc["authors"][&name] = serde_json::json!({ "author": me });
    let text = serde_json::to_string_pretty(&doc).unwrap() + "\n";
    seed.push(match authors {
        Some((sha, _)) => FileChange::update("authors.json", text.as_bytes(), sha),
        None => FileChange::create("authors.json", text.as_bytes()),
    });
    admin
        .change_files(&repo.owner, &repo.repo, &ChangeFilesRequest {
            branch: "main".into(),
            new_branch: None,
            message: format!("seed {name}"),
            files: seed,
        })
        .await
        .expect("准备数据应当成功");

    // ② 本机身份 = 作者
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    let env = TmpEnv { home: home.clone() };
    let store = Store::new(home.join(".skillsync"));
    let mut config = Config::default();
    config.identities.insert("company".into(), Identity { login: me.clone(), display_name: me.clone() });
    store.save_config(&config).unwrap();
    let registry = AgentRegistry::builtin();
    let trash = fsops::SandboxTrash::new(home.join(".test-trash"));
    let installer = Installer::new(&registry, &env).with_trasher(&trash);

    let run = |confirm: Option<String>| {
        let (admin, installer, env, store, repo, skill_path, name) = (&admin, &installer, &env, &store, &repo, &skill_path, &name);
        async move {
            unpublish(
                &ShareClient::Gitea(admin),
                admin,
                installer,
                env,
                store,
                UnpublishRequest {
                    registry_id: "company",
                    repo,
                    dir_slug: name,
                    skill_path,
                    display_name: name,
                    confirm: confirm.as_deref(),
                    also_trash_local: false,
                },
            )
            .await
        }
    };

    // ③ 预览 → 确认
    let UnpublishOutcome::NeedsConfirm { files, remote_rev, .. } = run(None).await.unwrap() else {
        panic!("预览轮应当要确认");
    };
    assert_eq!(files, ["SKILL.md", "ref.md"]);
    let out = run(Some(remote_rev)).await.expect("作者应当删得掉");
    assert!(matches!(out, UnpublishOutcome::Unpublished { .. }), "{out:?}");

    // ④ 库里真的没了,authors.json 里那一条也没了
    let head = admin.branch_head(&repo).await.unwrap();
    let left: Vec<String> = admin
        .tree_files(&repo.owner, &repo.repo, &head.sha)
        .await
        .unwrap()
        .into_iter()
        .map(|f| f.path)
        .filter(|p| p.starts_with(&format!("{skill_path}/")))
        .collect();
    assert!(left.is_empty(), "技能文件应当全部删掉:{left:?}");
    let (_, bytes) = admin.file_content(&repo, "authors.json").await.unwrap().unwrap();
    let doc: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(doc["authors"].get(&name).is_none(), "authors.json 里的条目应当一并清掉");
}
