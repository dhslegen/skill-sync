//! 更新日志的**状态迁移**:"这台机器上次看到的是哪一版"这条记账何时被写。
//!
//! 判定本身(`release_notes::decide`)是纯函数,九档单测在 `core/release_notes.rs`。
//! 这里测的是**编排**——与 `tests/plaza_ensure_repo.rs` 同一套写法:命令薄壳锁在
//! 真实 `HOME` 上不直接测,把它的三步(读 config → 判定 → 按需写回)抽成收 `Store`
//! 的 core 函数,用临时目录注入。
//!
//! 🔴 为什么非测不可:漏掉"静默采认基线"这一步的话,**全新安装的用户走完首次启动
//! 向导、第二次打开应用时会被告知「已更新到 x」**——他从没更新过。而这条缺陷
//! 在纯函数那九档里**一档都看不出来**(每一档的输入输出都是对的),它只存在于
//! "wizardDone 这个一次性判据没有被消费掉"这个状态迁移里。

use skillsync_lib::core::release_notes::{self, ReleaseNote};
use skillsync_lib::core::state::{Store, UiPrefs};

fn store_with(wizard_done: bool, last_seen: Option<&str>) -> (tempfile::TempDir, Store) {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::new(tmp.path().join(".skillsync"));
    let mut config = store.load_config().unwrap().value;
    config.ui = Some(UiPrefs {
        theme: "light".into(),
        accent: "clay".into(),
        wizard_done,
    });
    config.last_seen_version = last_seen.map(str::to_string);
    store.save_config(&config).unwrap();
    (tmp, store)
}

fn notes() -> Vec<ReleaseNote> {
    release_notes::parse("## 0.5.0 —— 新的\n\n正文 5\n\n## 0.4.0 —— 旧的\n\n正文 4\n")
}

#[test]
fn a_brand_new_install_records_the_baseline_without_showing_anything() {
    // 首启:向导还没做完 = 全新安装。不显示,但**必须把当前版本记下来**。
    let (_tmp, store) = store_with(false, None);

    let state = release_notes::resolve(&store, notes(), "0.5.0").unwrap();

    assert!(state.pending.is_empty(), "全新安装不该被更新日志迎面拦住");
    assert_eq!(
        store.load_config().unwrap().value.last_seen_version.as_deref(),
        Some("0.5.0"),
        "基线没记下来 —— 向导做完之后 wizardDone 变 true,下次启动这个从没更新过的人\
         就会被告知「已更新到 0.5.0」"
    );
}

#[test]
fn the_same_brand_new_user_is_still_not_greeted_after_finishing_the_wizard() {
    // 上一条的后续:向导做完了(wizardDone=true),基线已在首启时记下。
    let (_tmp, store) = store_with(false, None);
    release_notes::resolve(&store, notes(), "0.5.0").unwrap();

    // 模拟"向导做完"
    let mut config = store.load_config().unwrap().value;
    config.ui.as_mut().unwrap().wizard_done = true;
    store.save_config(&config).unwrap();

    let second = release_notes::resolve(&store, notes(), "0.5.0").unwrap();

    assert!(second.pending.is_empty(), "他从没更新过,不该看到「已更新到」");
}

#[test]
fn an_existing_user_upgrading_sees_the_notes_and_the_baseline_is_not_touched_yet() {
    // 存量用户第一次升上来:显示,但**这时候还不能写基线**
    // ——写了就等于"显示即已读",用户升级后立刻退出就永远看不到了。
    let (_tmp, store) = store_with(true, None);

    let state = release_notes::resolve(&store, notes(), "0.5.0").unwrap();

    assert_eq!(state.pending.len(), 1);
    assert_eq!(
        store.load_config().unwrap().value.last_seen_version,
        None,
        "读一次状态就把基线写掉的话,没点关闭就退出的人再也看不到这一版的说明"
    );
}

#[test]
fn acknowledging_writes_the_current_version() {
    let (_tmp, store) = store_with(true, Some("0.4.0"));

    release_notes::acknowledge(&store, "0.5.0").unwrap();

    assert_eq!(
        store.load_config().unwrap().value.last_seen_version.as_deref(),
        Some("0.5.0")
    );
}

#[test]
fn a_config_without_ui_at_all_is_treated_as_a_brand_new_install() {
    // ui 为 None = 从未设置过外观,只可能是全新安装。
    // 当成存量用户的话,新人第一次打开就被一版他没装过的日志迎面拦住。
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::new(tmp.path().join(".skillsync"));

    let state = release_notes::resolve(&store, notes(), "0.5.0").unwrap();

    assert!(state.pending.is_empty());
    assert_eq!(
        store.load_config().unwrap().value.last_seen_version.as_deref(),
        Some("0.5.0"),
        "基线同样要记下来,否则第一次开外观设置之后就会冒出假的「已更新到」"
    );
}
