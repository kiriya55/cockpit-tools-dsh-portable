# cockpit-tools DSH 可移植捆绑包

此归档包含一个可安装、仅含配置的 DSH 捆绑包，以及 `cockpit-tools-model-sync` 技能。它旨在被暂存到任意 DSH 主目录下，并安装到所选配置档中。它**不包含 API 密钥、浏览器会话机密或特定于机器的路径**。

## 内容

- `bundle/` — 本地 DSH 捆绑包（`package.json` + `cordis.patch.yml`）、可移植模型同步脚本、默认排除列表、本地化元数据和图标。
- `skills/cockpit-tools-model-sync/SKILL.md` — 用户可调用的技能，用于调用已暂存的同步脚本。
- `install.mjs` — 跨平台 Node.js 暂存辅助工具。

要求：Node.js 18+；带有 `@deepseek-ai/dsh-llm-pi-ai` 的 DSH 安装；以及 cockpit-tools 在将使用该提供商的机器上本地运行。

## 安装（推荐）

1. 将此归档解压到一个持久目录。
2. 将捆绑包和技能暂存到目标 DSH 主目录。默认主目录是 `$DSH_HOME`；如果该变量未设置，则为 `~/.dsh`：

   ```sh
   node install.mjs --dsh-home "$HOME/.dsh" --profile web
   ```

   Windows PowerShell：

   ```powershell
   node .\install.mjs --dsh-home "$HOME\.dsh" --profile desktop
   ```

   安装程序会将捆绑包复制到 `<DSH_HOME>/cockpit-tools-provider`，将技能复制到 `<DSH_HOME>/skills/cockpit-tools-model-sync`，然后同步本地模型目录，并且仅在该引用不存在时添加 `refs.COCKPIT_TOOLS_API_KEY`。如果 cockpit-tools 尚未运行，请在暂存期间使用 `--skip-sync`，并在启动后运行同步命令。在现有已暂存版本上重新运行需要 `--force`；它会首先创建带时间戳的备份。

3. 在目标配置档中安装已暂存的捆绑包：

   ```sh
   dsh plugin --profile web add "$HOME/.dsh/cockpit-tools-provider"
   ```

   将 `web` 替换为目标配置档。请使用已初始化的现有配置档（例如 `web` 或 `desktop`）；如果需要新的配置档，请先从随附的 DSH 配置档模板创建它。仅安装捆绑包可能只会初始化基础配置档，而不是你想要的 UI/配置档变体。在 DSH Desktop 上，使用其插件页面 → **安装第三方插件**，并选择 `cockpit-tools-provider` 的绝对目录，或使用 Desktop 自有的 `plugin_manager` `install_bundle` 操作并传入该绝对路径。在已安装的 Desktop CLI 上，受支持的插件子命令是 `dsh plugin --profile desktop add <absolute-directory>`；通用的 `dsh --profile desktop ...` 命令不能与之互换。

4. 重新打开模型选择器，然后选择 **Cockpit Tools 反代**。默认模型不会更改。

## 后续更新模型信息

让 DSH 智能体执行“同步 cockpit 模型”，或直接运行已暂存的脚本：

```sh
node "$HOME/.dsh/cockpit-tools-provider/sync-cockpit-models.mjs" \
  --dsh-home "$HOME/.dsh" \
  --patch "$HOME/.dsh/cockpit-tools-provider/cordis.patch.yml" \
  --profile web --check
```

移除 `--check` 以应用更新。该脚本读取本地 cockpit-tools 配置（`~/.cockpit_tools/codex_local_access.json` 或 `~/.antigravity_cockpit/codex_local_access.json`），查询 `/v1/models`，对凭据进行脱敏，保留现有凭据引用，并备份其更改的文件。每个使用该捆绑包的 DSH 主目录/配置档都应在运行其 cockpit-tools 代理的同一台机器上同步。

捆绑包补丁文件是包内容。在模型目录更新后，如果模型选择器尚未刷新，请重新启用/重新加载捆绑包或重启 DSH 客户端；包补丁文件不保证会被配置档 HMR 监视。

## 兼容性与配置说明

- 该捆绑包在 `http://127.0.0.1:<port>/v1` 上通过 OpenAI Responses 声明提供商 `cockpit-tools`；初始模型目录是快照。同步脚本会根据本地代理调整端口和模型列表。
- `COCKPIT_TOOLS_API_KEY` 是一个 DSH 凭据**引用**。实际密钥从本地 cockpit-tools 配置中读取，不存储在此归档中。如果该引用已存在于目标 `.credentials.yaml` 中，更新程序会有意不覆盖它。
- DSH Loader 会替换插件行的完整 `config`；它不会深度合并 `llm-pi-ai.config`。在已有自定义 `llm-pi-ai` 提供商配置的配置档上，请将此捆绑包的 `providers.cockpit-tools` 条目与现有提供商映射合并（保留现有提供商），或使用干净的配置档。更高优先级的主目录/配置档/启动补丁可以覆盖此捆绑包。
- `gpt-reserve` 默认被排除，因为它返回了 `503 no_available_account`；编辑 `bundle/models-exclude.json` 可更改该策略。隐藏模型（如 `gpt-image-2.5` 和 `codex-auto-review`）会被同步工具过滤。
- 该捆绑包是仅含配置的 Cordis 包；不需要插件代码或第三方运行时依赖。

## 手动暂存

如果你不想运行辅助工具，请将 `bundle/` 复制到 `<DSH_HOME>/cockpit-tools-provider`，并将 `skills/cockpit-tools-model-sync/` 复制到 `<DSH_HOME>/skills/cockpit-tools-model-sync`，然后按照步骤 3 操作。如果希望预览，请在同步前运行 `--check` 命令。