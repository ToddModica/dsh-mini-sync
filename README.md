# dsh-mini-sync

**用你自己的 WebDAV，在几台机器之间同步 DeepSeek Harness 的最小配置。**

模型供应商、API Key、Base URL、插件列表和设置会跟着走——对话永远不会。

远端只放一个加密文件。同步间隔可调。旧文件策略可调。

---

## 为什么做这个

DSH 的配置散在几个文本文件里，其中一部分是与机器绑定的。
现有的备份类插件解决的是*搬家*问题：它们把整个 `$DSH_HOME` 打包（连会话一起），
再往网盘里堆一摞快照。当你只是想让每台机器上的 provider 和 API Key 保持一致时，
这个形状并不合适。

`dsh-mini-sync` 只做这一件事：

|  | dsh-mini-sync |
|---|---|
| 对话 / 会话 | 从不触及 |
| 远端结构 | 一个文件 `config.json`（只有你主动要求才有 `history/`） |
| 保留策略 | `keepVersions: 0` → 单文件，原地覆盖 |
| 同步间隔 | `intervalMinutes`，0 = 纯手动 |
| API Key | 包含，上传前用 AES-256-GCM 加密 |
| 运行时依赖 | 仅 `js-yaml` |

---

## 同步什么

| 载荷键 | 来源 | 说明 |
|---|---|---|
| `profile/cordis.patch.yml` | `$DSH_HOME/profiles/<profile>/` | 供应商、模型、Base URL、请求头、UI 配置 |
| `profile/package.json` | 同上 | bundle 列表与 npm 插件 |
| `settings.yaml` / `settings.json` | `$DSH_HOME/` | 全局设置 |
| `AGENTS.md` | `$DSH_HOME/` | 全局指令 |
| `skills/**` | `$DSH_HOME/skills/` | 仅文本文件，可关闭 |
| `.credentials.yaml` | `$DSH_HOME/` | **加密**，可关闭 |

从不上传：`sessions/`、`storages/`、附件、工作区注册表、`node_modules`。

### 只同步你自己加的供应商

其他工具和网关会往同一份 `cordis.patch.yml` 里写它们自己的 provider 和模型。
不做限定的话，这些都会跟着到每一台机器上。

`syncProviders` 是白名单。留空表示"全部同步"；一旦设置，只有点名的条目会进入上传载荷：

```yaml
syncProviders:
  - my-provider                   # 整个 provider，全部模型
  - my-provider/Qwen/qwen3-max    # 单个模型（模型 id 可能含斜杠）
```

**过滤只作用于上传载荷，绝不改动本机的 `cordis.patch.yml`。**
拉取时同样是窄合并：只取白名单里的 provider，本机已有的其他 provider 原样保留；
本地有、远端没有的模型也不会被删除。

### 与机器绑定的路径

profile 的 `package.json` 常常带有指向本机绝对路径的 `link:` 依赖。
把它们送到另一个系统上会让 profile 装不起来。推送时这类条目会被剔除并报告，
而 `dsh.bundle` 列表照常同步，在目标机器上 `dsh plugin add` 即可装回。

跨系统的绝对路径改写用 `pathMap`：

```json
[{ "from": "C:\\Users\\alice\\", "to": "/Users/alice/" }]
```

### 只在单机有效的 Base URL

绑定在 `127.0.0.1:<端口>` 上的网关，只有写它的那台机器能访问。怎么处理取决于你的情况：

- **每台机器同端口**（各自本地装了网关）→ `127.0.0.1:10100` 在每台机器上都对，不用改。
  推送时若看到 loopback 地址会给出提示，让这成为一个明确的选择而不是意外。
- **共用一台网关**（NAS、局域网主机或 Tailscale）→ 推送时改写：

```yaml
rewriteBaseURL:
  - { match: '127.0.0.1:10100', replace: 'gateway.lan:10100' }
```

插件里没有任何硬编码的端口、主机，也不假设本机一定有网关。

---

## 安装

```bash
dsh plugin --profile web add github:<owner>/dsh-mini-sync
```

重启 DSH。设置页会出现 **轻量同步** 一项。

---

## 使用

### 图形界面

设置 → **轻量同步**，一页搞定：

- **连接**：WebDAV 地址、用户名、密码、加密口令、远端目录
- **同步节奏**：间隔（0/15/30/60/180 分钟或自定义）、远端保留（单文件 / 3 / 5 / 10 个版本）
- **同步内容**：是否带 API 凭据、技能目录、启动时自动拉取
- **模型供应商**：逐个勾选 provider 与模型；本机地址会标出来
- **操作**：保存设置、立即推送、预览远端、拉取并应用

密码和口令只写入 DSH 凭据库，不会出现在页面之外的任何文件里。

### 对话里

| 工具 | 作用 |
|---|---|
| `mini_sync_push` | 把本机配置作为一个加密文件上传 |
| `mini_sync_pull` | 比对，并在 `apply` 时写入远端配置 |
| `mini_sync_status` | 目标、间隔、保留策略、上次推送/拉取、将同步哪些文件 |
| `mini_sync_setup` | 修改任意设置，含间隔与保留 |

也可以直接说 `/sync status`、`/sync push`、`/sync pull [apply]`。

最小提示词：

> 配置 mini sync：WebDAV 填 https://你的地址，用户名 me，密码 ***，口令 ***，30 分钟同步一次，只保留一个文件，只同步 opencodex。

### 日常流程

1. A 机：推送。
2. B 机（新机器）：填同样的地址与口令，然后**预览远端**，确认后**拉取并应用**。
   每个被覆盖的文件旁都会留一份 `.dsh-mini-sync.bak`。
3. 之后改了 API Key：在改动的那台机器上再推一次。`keepVersions: 0` 时远端文件直接被替换，不会堆积。

### 冲突处理

`pull` 针对上次同步状态做三方比较：

- 远端改过、本地没动 → **更新**
- 本地有文件但没有同步基线（新设备）→ **采纳**
- 本地在上次同步后改过 → **冲突**，保持原样
- `force: true` → 覆盖，但先写 `.bak`

默认是演练模式：不传 `apply: true` 就什么都不写。

---

## 安全

- 载荷用 **AES-256-GCM** 加密，密钥由 **scrypt** 从口令派生。网盘和 WebDAV 服务商只看得到密文。
- WebDAV 密码与口令存在 DSH 凭据库（`.credentials.yaml`），不写入 `cordis.patch.yml`，
  也不进入载荷元数据。
- 口令错误会明确报错，不会返回垃圾数据。
- 只有 `includeCredentials` 为真时才带上 `.credentials.yaml`，且与其余内容受同一层加密保护。
- 真正的秘密是口令：任何同时拿到远端文件和口令的人就拿到了你的 API Key。

---

## 开发

```bash
node test/e2e.mjs     # 49 项检查，本地起 WebDAV 桩，无需联网
```

覆盖加密、远端单文件结构、对话隔离、演练不写盘、冲突处理、保留策略裁剪、
跨系统 link 剔除、供应商白名单、跨机合并、Base URL 改写与 loopback 提示，
以及页面所用的 HTTP 路由（含跨源拒绝与口令不外泄）。

## 许可

MIT