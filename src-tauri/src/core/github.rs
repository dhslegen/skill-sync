//! GitHub client(GraphQL createCommitOnBranch + zipball)。**仍是空壳,归 M3**。
//!
//! 开工前必读:`gitea::app_http_client()` 对全部请求 `.no_proxy()`,那是 M1
//! "只有内建源且必在内网"的正确语义。**接外网 GitHub 源时必须按 registry 决定
//! 代理策略**,否则公司代理网络下直接连不上——这是 M3 唯一一处需要推翻 M1 决定的地方。
//! 测试注意:reqwest 对 loopback 目标默认豁免代理,拿 wiremock 当目标测代理行为
//! 必然空转(绕法见 `tests/proxy_bypass.rs`)。
