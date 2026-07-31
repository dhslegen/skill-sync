//! 系统代理绕过(任务 13 拍板的方案,见 gitea.rs 模块头)。
//!
//! 企业机器普遍配了 `http_proxy` 访问外网;内网 Gitea 若不在 `NO_PROXY` 里,
//! 请求会被转给代理——代理连不到内网地址,用户在登录第一步就拿到看不懂的失败。
//! M1 只有内建这一个源,而它一定在内网:**直连就是正确语义**。
//!
//! # 为什么不用 wiremock 当目标
//!
//! reqwest 对 loopback 地址默认豁免代理——拿 127.0.0.1 当目标,带不带 `no_proxy()`
//! 行为完全一样,那条测试怎么写都是绿的(注入验证当场揭穿)。
//! 这里改用**不可解析的假域名**当目标:走代理 → 代理应答,请求成功;
//! 直连 → DNS 解析失败。可达性本身就是判别器。
//! 并保留一个"默认 client 会走代理"的对照组:装置失效时它先红。
//!
//! 环境变量是进程级全局的,整个文件只有一个测试,避免并行互踩。

use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn the_app_client_never_hands_intranet_requests_to_a_proxy() {
    let proxy = MockServer::start().await;
    // 假代理对一切请求都应答(代理收到的是绝对 URI 的普通 GET)
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_string("FROM_PROXY"))
        .mount(&proxy)
        .await;

    // `.invalid` 是 RFC 2606 保留 TLD,保证解析不了——直连必失败,走代理必成功
    let target = "http://skillsync-gitea.invalid";

    std::env::set_var("HTTP_PROXY", proxy.uri());
    std::env::set_var("http_proxy", proxy.uri());

    // 对照组:默认构造的 client 确实会把这个请求交给代理。
    // 这一步红了说明测试装置失效(比如 reqwest 又变了豁免规则),主断言就不可信。
    let default_client = reqwest::Client::new();
    let via_proxy = default_client
        .get(format!("{target}/api/v1/version"))
        .send()
        .await
        .expect("对照组:默认 client 应当能经代理拿到应答")
        .text()
        .await
        .unwrap();
    assert_eq!(via_proxy, "FROM_PROXY", "对照组失效:默认 client 没走代理");
    assert_eq!(proxy.received_requests().await.unwrap().len(), 1);

    // 主断言:app 的 client 拒绝代理——直连不可解析域名,只能失败,且代理没收到新请求
    let http = skillsync_lib::core::gitea::app_http_client().expect("构造 http client 失败");
    let client =
        skillsync_lib::core::gitea::GiteaClient::with_http(target.to_string(), None, http);
    let repo = skillsync_lib::core::gitea::RepoRef {
        owner: "skills".into(),
        repo: "skills".into(),
        branch: "main".into(),
    };
    let err = client
        .branch_head(&repo)
        .await
        .expect_err("app client 若走了代理,这里会成功——那正是要防的事故");
    assert_eq!(err.code, "NET_UNREACHABLE", "直连失败应映射为看得懂的联网提示");
    assert_eq!(
        proxy.received_requests().await.unwrap().len(),
        1,
        "app 的请求被交给了系统代理"
    );

    std::env::remove_var("HTTP_PROXY");
    std::env::remove_var("http_proxy");
}
