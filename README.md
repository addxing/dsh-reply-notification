# dsh-reply-notification

非官方 DeepSeek Harness (DSH) 插件：回复完成后发送 macOS 桌面通知。

## 功能

- 会话标题 + 本轮最后一条回复的前 120 个字符。
- DSH 桌面应用在前台获得焦点时静默，不弹窗也不播放声音。
- 仅主会话正常完成时通知；工具调用、队友/子智能体、取消及错误不通知。
- 使用用户本机 DSH 应用图标，不在 npm 包内分发 DSH 图标。

## 安装

使用 DeepSeek Harness Desktop 时，先启动一次以初始化配置，然后完全退出应用，在终端执行：

```bash
dsh plugin --profile desktop add github:addxing/dsh-reply-notification
```

也可以从 npm 安装：

```bash
dsh plugin --profile desktop add dsh-reply-notification
```

安装后重新打开 Desktop，并在插件管理中启用“回复完成通知”。其他 DSH 配置可将 `desktop` 替换为对应的 profile 名称。

如果终端找不到 `dsh`，可在 Desktop 的应用菜单中选择 **Manage dsh Command…** 安装命令。macOS 默认安装路径下，也可以用 `"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"` 代替 `dsh`。

要求 macOS（支持 Apple Silicon 和 Intel）、Node.js 22+、DSH 0.2.2-rc.1 或后续兼容的 0.2.x 版本。需将 DSH 安装在 `/Applications/DeepSeek Harness.app` 或 `~/Applications/DeepSeek Harness.app`。

插件没有安装脚本。首次在后台发送通知时，会在用户的 `~/Library/Application Support/dsh-reply-notification/1.2.0/` 创建独立辅助应用，从本机 DSH 复制图标，使用系统 `codesign` 进行本地 ad-hoc 签名并通过 LaunchServices 注册，不修改 DSH 本体。这不是 Apple Developer 签名或公证。

首次请允许“DSH 回复通知”发送通知；也可在 **系统设置 → 通知 → DSH 回复通知** 中开启横幅及声音。专注模式会影响显示。

## 隐私与边界

- 标题及正文预览会进入系统通知中心，锁屏预览由系统设置决定。
- 不显示思考或工具结果；无文字回复时显示固定提醒。
- 不上传会话内容、不回放历史通知。卸载插件不会自动删除已交由 macOS 保存的通知或辅助应用。
- 桌面应用级焦点检测不包含浏览器中的 DSH 页面。
- 辅助应用无会话跳转操作；通知大小与行数由 macOS 决定。
- DSH 图标只在用户本机使用，本包不授予该图标的再分发权。

## 开发

本仓库以 npm 发布包中的文件为基础，测试文件未随该包发布。第三方工具 terminal-notifier 3.1.0 以 MIT 许可提供，详见 THIRD-PARTY-NOTICES.md。

本项目不是 DeepSeek 官方产品。
