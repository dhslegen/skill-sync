//! 项目清单记账(`config.projects`)与项目路径守卫。
//!
//! 设计取舍见 `core::project` 模块头:**技能级真相只在各项目的 `skills-lock.json` 里**,
//! 全局 config 只记"用户碰过哪些项目"的路径清单,零双份记账。

use std::path::{Path, PathBuf};

use skillsync_lib::core::project::{self, ProjectPathError};

fn home() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    (tmp, home)
}

/// canonical 全局技能目录(守卫要拦它自己、祖先与其之下)。
fn canonical(home: &Path) -> PathBuf {
    home.join(".agents/skills")
}

fn ok(home: &Path, p: &Path) -> Result<PathBuf, ProjectPathError> {
    project::validate_project_path(p, home, &canonical(home))
}

/// 普通工作目录:放行,并归一化成绝对路径。
#[test]
fn accepts_an_ordinary_existing_directory() {
    let (tmp, home) = home();
    let proj = tmp.path().join("我的工作");
    std::fs::create_dir_all(&proj).unwrap();

    let got = ok(&home, &proj).expect("普通目录应放行");

    // ⚠️ 比的是 canonicalize 之后的值:macOS 上 /var 是指向 /private/var 的软链,
    // 实现刻意做归一化(不做的话 HOME 本身是软链的机器上守卫会比出假阴性)。
    assert_eq!(got, std::fs::canonicalize(&proj).unwrap());
}

/// 不存在的路径:拒绝。**绝不替用户创建目录**(与 watcher 同一条纪律)。
#[test]
fn rejects_a_path_that_does_not_exist_without_creating_it() {
    let (tmp, home) = home();
    let missing = tmp.path().join("并不存在");

    let err = ok(&home, &missing).expect_err("不存在的路径应拒绝");

    assert_eq!(err, ProjectPathError::NotFound);
    assert!(!missing.exists(), "绝不能替用户把目录创建出来");
}

/// 文件(不是目录):拒绝。
#[test]
fn rejects_a_file() {
    let (tmp, home) = home();
    let f = tmp.path().join("一个文件.txt");
    std::fs::write(&f, "x").unwrap();

    assert_eq!(ok(&home, &f), Err(ProjectPathError::NotADirectory));
}

/// HOME 本身:拒绝。往家目录根上装技能会把 `.agents/` 变成全局那一份。
#[test]
fn rejects_the_home_directory_itself() {
    let (_tmp, home) = home();
    assert_eq!(ok(&home, &home), Err(ProjectPathError::IsHome));
}

/// canonical 自身与它的**祖先**:拒绝(祖先含 `~/.agents`)。
#[test]
fn rejects_canonical_and_its_ancestors() {
    let (_tmp, home) = home();
    let c = canonical(&home);
    std::fs::create_dir_all(&c).unwrap();

    assert_eq!(ok(&home, &c), Err(ProjectPathError::InsideCanonical));
    assert_eq!(
        ok(&home, &home.join(".agents")),
        Err(ProjectPathError::InsideCanonical)
    );
}

/// 🔴 canonical **之下**:拒绝。
///
/// 选进 `~/.agents/skills/<某技能>/` 会把 `skills-lock.json` 与 `.agents/` 写进
/// 那个已装技能的本体,`dir_content_hash` 当场漂移 → 全站误报「你改过这个技能」。
#[test]
fn rejects_a_directory_underneath_canonical() {
    let (_tmp, home) = home();
    let inside = canonical(&home).join("weekly-report");
    std::fs::create_dir_all(&inside).unwrap();

    assert_eq!(ok(&home, &inside), Err(ProjectPathError::InsideCanonical));
}

/// 对照组:HOME 之下的普通目录要放行,否则上面几条可能是"什么都拒绝"的假绿。
#[test]
fn accepts_a_normal_directory_under_home() {
    let (_tmp, home) = home();
    let proj = home.join("文档/项目甲");
    std::fs::create_dir_all(&proj).unwrap();

    assert!(ok(&home, &proj).is_ok(), "HOME 下的普通目录必须放行");
}

// ============================================================ 项目清单记账

/// 登记是幂等的:同一路径重复登记只留一条(**条数**,顺序由下一条测试管)。
#[test]
fn registering_the_same_project_twice_keeps_one_entry() {
    let mut list: Vec<String> = Vec::new();

    project::register_project(&mut list, Path::new("/w/a"));
    project::register_project(&mut list, Path::new("/w/a"));
    project::register_project(&mut list, Path::new("/w/b"));

    assert_eq!(list.len(), 2, "重复登记不该留下两条 /w/a,实际 {list:?}");
    assert!(list.contains(&"/w/a".to_string()));
    assert!(list.contains(&"/w/b".to_string()));
}

/// 最近使用的排在前面——界面「最近项目」直接取前 N 条。
#[test]
fn re_registering_moves_a_project_to_the_front() {
    let mut list: Vec<String> = Vec::new();
    project::register_project(&mut list, Path::new("/w/a"));
    project::register_project(&mut list, Path::new("/w/b"));

    project::register_project(&mut list, Path::new("/w/a"));

    // 最近用的在最前:b 后登记本来在前,再动一次 a 之后 a 回到最前。
    assert_eq!(list, vec!["/w/a".to_string(), "/w/b".to_string()]);
}

/// 移出清单是**纯记账**:只动列表,不碰磁盘。
#[test]
fn forgetting_a_project_only_touches_the_list() {
    let (tmp, _home) = home();
    let proj = tmp.path().join("proj");
    std::fs::create_dir_all(proj.join(".agents/skills/x")).unwrap();
    std::fs::write(proj.join(".agents/skills/x/SKILL.md"), "x").unwrap();
    let mut list = vec![proj.to_string_lossy().into_owned()];

    project::forget_project(&mut list, &proj);

    assert!(list.is_empty());
    assert!(
        proj.join(".agents/skills/x/SKILL.md").is_file(),
        "移出清单绝不能删用户的技能"
    );
}
