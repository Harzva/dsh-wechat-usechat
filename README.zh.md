# DSH 微信 UseChat 插件

本插件通过已发布的 [UseChat](https://github.com/CosmosShadow/usechat) 0.1.0 CLI，为 DSH 提供 `usechat_doctor`、`usechat_read`、`usechat_send_text` 三个工具。插件仅在 GitHub 发布；不自动安装 Helper，不在启动时访问微信，不运行安装脚本。安装命令、变量和回执细则见 [English README](README.md)。

## 安装与配置

使用审核过的 Git commit，安装到独立 DSH profile；现有 OpenBot 市场桥接只准备 npm 来源，不能把 GitHub 上架视为 OpenBot 在线安装成功。

```sh
export DSH_HOME=/absolute/private/dsh-home
dsh plugin --profile sdk-minimal add 'git+https://github.com/Harzva/dsh-wechat-usechat.git#<reviewed-commit>' --ignore-scripts
dsh --profile sdk-minimal --dump-config
```

由宿主设置 `USECHAT_DSH_CONFIG`（现有绝对配置路径）、`USECHAT_DSH_ALLOWED_CHATS`（精确群/联系人名称 JSON 数组）和所有 BOT 共用的私有 `0700` `USECHAT_DSH_UI_LEASE_DIR`。也可由 Cordis 插件配置提供 `configPath`、`allowedChats`、`writeEnabled`、`receiptDir`、`uiLeaseDir`。默认禁止发送。插件内置 DSH 的逐次 `ask` 审批；没有审批服务或答复者时拒绝执行。宿主准备好审批后，才设置 `USECHAT_DSH_WRITE_ENABLED=1` 和预建的私有 `0700` `USECHAT_DSH_RECEIPTS_DIR`。上方 `sdk-minimal` 只作安装验收，不具备真实审批答复者。模型参数不能指定程序、配置、Helper、附件或回执目录。UI 租约超时后不会自动回收，须人工检查窗口与回执。

先按上游文档独立安装并验明 Helper 来源，用 `usechat setup-helper --from <verified-artifact>` 显式安装，然后配置视觉模型与所需系统权限。读取会把当前可见微信窗口截图和 OCR 发给所配置的视觉模型；API Key 用环境变量。`read` 只读白名单对话、最多 50 条、不下载附件。`send_text` 只发文本。

每次发送前插件先落盘回执。UseChat 的成功状态是 `sent-unconfirmed`，插件记录为 `submitted_unconfirmed`，并不声称对方已收到。超时、取消或失败标记 `uncertain` 并锁定后续发送；重复 `requestId` 不会重发。操作员需检查实际微信对话与回执后人工处理，不要换 ID 盲重试。自动测试未操作真实微信，也不等于真实微信功能验收。
