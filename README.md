# dsh-mini-sync

**用你自己的 WebDAV，在几台机器之间同步 DeepSeek Harness 的最小配置。**

模型供应商、API Key、Base URL、插件清单和设置会跟着走——对话永远不会。

远端只放一个文件。加密可选：设置口令就加密，留空就明文（并明确提醒）。
同步间隔可调，旧文件策略可调。新机器拉取时可以直接把缺失的插件装回来。

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
| API Key | 包含；可选 AES-256-GCM 加密（无口令则明文） |
| 插件 | 清单同步，可按清单装回缺失插件 |
| 远端文件 | 可查看与删除配置、历史版本 |
| 运行时依赖 | 仅 `js-yaml` |

---

## 0.3.0 更新

- **远端文件管理**：设置页新增「远端文件」卡片，可以查看 WebDAV 同步目录里现有的
  `config.json`、历史版本和其他文件，显示大小与修改时间，并可逐个删除（删除前需在
  行内二次确认）。
- 删除只接受同步目录里的文件：拒绝 `..`、绝对路径、未知子目录和 `history` 目录本身。

## 0.2.0 更新

- **深色模式**：设置页改用 Harness 真正定义的主题 token（`--dsw-alias-label-*`、
  `--dsw-alias-settings-card-fill`、`--dsw-alias-bg-base`…）。之前那些 token 在
  宿主里并不存在，颜色全部落回浅色字面值，深色模式下输入框变成黑底黑字。
- **加密口令可选**：不填口令（或关掉加密开关）就明文上传，并在推送结果和状态里
  明确警告；填了口令仍然 AES-256-GCM。
- **插件同步**：载荷新增 `plugins` 清单，记录 npm/GitHub 安装源与本地专用插件；
  拉取时可自动装回本机缺失的插件。本机有效的 `link:` 依赖不会再被远端覆盖掉。
- 数字输入框改成纯文本输入，避开深色主题下原生数字控件与页面不一致的问题。

---

## 同步什么

| 载荷键 | 来源 | 说明 |
|---|---|---|
| `profile/cordis.patch.yml` | `$DSH_HOME/profiles/<profile>/` | 供应商、模型、Base URL、请求头、UI 配置 |
| `profile/package.json` | 同上 | bundle 列表与 npm 插件 |
| `settings.yaml` / `settings.json` | `$DSH_HOME/` | 全局设置 |
| `AGENTS.md` | `$DSH_HOME/` | 全局指令 |
| `skills/**` | `$DSH_HOME/skills/` | 仅文本文件，可关闭 |
| `.credentials.yaml` | `$DSH_HOME/` | 随载荷加密或明文，可关闭 |
| `plugins` | profile 的 `package.json` + 插件管理器 | 插件清单与可移植安装源，不是磁盘文件 |

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

### 插件也会跟着走

`profile/package.json` 的依赖和 `dsh.profile.bundles` 决定装哪些插件。绝对路径的
`link:` / `file:` 依赖只在本机成立，上传副本会剔除它们；载荷里的 `plugins` 清单
则记录可移植的安装源：

| 本机依赖 | 清单里的 spec |
|---|---|
| `dsh-cost-meter: 1.9.58` | `dsh-cost-meter@1.9.58`（按已安装版本） |
| `link:D:\repos\foo`，其 package.json 有 GitHub `repository` | `github:owner/foo` |
| 本地链接但没有仓库地址 | 无 spec，标记 `localOnly` |

拉取时先报告缺哪些。打开「拉取时安装缺失插件」（`installPlugins`）后，会用宿主
插件管理器安装清单里有 spec 的那些；安装可能提示重启。`localOnly` 插件不会被
假装装回，只会明确列出，需要手动 `dsh plugin add`。

本机仍然能解析的 `link:` 依赖在写入远端 `package.json` 时会保留，不会被抹掉；
已经失效的链接会被清理。给插件补一个 `repository` 字段，它就能跨机器装回。
`dsh-mini-sync` 自己的清单里就有这个字段，所以它也能以
`github:ToddModica/dsh-mini-sync` 的形式装回。

### 与机器绑定的路径

配置正文里的绝对路径用 `pathMap` 改写：

```json
[{ "from": "C:\\Users\\alice\\", "to": "/Users/alice/" }]
```

`pathMap` 只改文件内容；`link:` 依赖不会靠它跨机器，因为 DSH 需要目标机器上
真实存在的插件目录。跨机器请使用上面的插件清单。

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
dsh plugin --profile web add github:ToddModica/dsh-mini-sync
```

重启 DSH。设置页会出现 **轻量同步** 一项。

---

## 使用

### 图形界面

设置 → **轻量同步**，一页搞定：

- **连接**：WebDAV 地址（只粘地址即可）、用户名、密码、**可选**加密口令、加密开关
- **同步节奏**：间隔（0/15/30/60/180 分钟或自定义）、远端保留（单文件 / 3 / 5 / 10 个版本）
- **同步内容**：是否带 API 凭据、技能目录、启动时自动拉取
- **插件**：本机插件清单、是否在拉取时装回缺失插件
- **模型供应商**：逐个勾选 provider 与模型；本机地址会标出来
- **操作**：保存设置、立即推送、预览远端、拉取并应用
- **远端文件**：列出远端目录里的配置、历史版本和其他文件，可逐个删除

密码和口令只写入 DSH 凭据库，不会出现在页面之外的任何文件里。
口令留空时推送会明确标注「明文」，状态页也会一直提示，直到你设置口令。

### 查看和删除远端文件

设置 → **轻量同步** → **远端文件** → **查看远端文件**。列表会显示同步目录里的：

- `config.json`：当前远端配置；
- `history/v-*.json`：保留的历史版本（`keepVersions > 0` 时才有）；
- 其他直接放在该目录里的文件。

每一行都有删除按钮；点一下会变成行内「确认删除 / 取消」，不会一点就删。
删除只作用于同步目录内的文件，`..`、绝对路径、未知子目录和 `history` 目录本身都会被拒绝。
删掉 `config.json` 等于清空远端配置，其他机器将无法再拉取。

### 只需要粘一个地址

不必手动建文件夹，也不必填子目录名。把 WebDAV 目录地址粘进去就行：

```
https://dav.example.com/remote.php/dav/files/me/
```

插件会在其下自动创建 `dsh-mini-sync/`（多层也会逐级创建），实际落点会直接显示在
页面的「存放位置」里，例如
`https://dav.example.com/remote.php/dav/files/me/dsh-mini-sync/config.json`。

地址的几种写法都会被归一化，不会出现重复目录：

| 你粘的 | 实际使用 |
|---|---|
| `…/me/` | `…/me/dsh-mini-sync` |
| `…/me/dsh-mini-sync` | `…/me/dsh-mini-sync`（不会变成 `dsh-mini-sync/dsh-mini-sync`） |
| `…/me/dsh-mini-sync/config.json` | `…/me/dsh-mini-sync` |

唯一的前提是：地址指向的**目录本身必须已存在**，否则会明确报 409 并说明原因
（很多网盘的根路径并不允许随意创建）。

### 对话里

| 工具 | 作用 |
|---|---|
| `mini_sync_push` | 把本机配置作为一个文件上传（有口令则加密） |
| `mini_sync_pull` | 比对，并在 `apply` 时写入远端配置；可顺带装回缺失插件 |
| `mini_sync_status` | 目标、加密状态、插件清单、间隔、保留策略、上次推送/拉取 |
| `mini_sync_setup` | 修改任意设置，含口令、加密开关、间隔、保留与插件安装 |

也可以直接说 `/sync status`、`/sync push`、`/sync pull [apply]`。

最小提示词：

> 配置 mini sync：WebDAV 填 https://你的地址，用户名 me，密码 ***，口令 ***，30 分钟同步一次，只保留一个文件，只同步 opencodex，拉取时把缺失插件装回来。

### 日常流程

1. A 机：推送。
2. B 机（新机器）：填同样的地址（有口令就填同一个口令），然后**预览远端**，确认后**拉取并应用**。
   每个被覆盖的文件旁都会留一份 `.dsh-mini-sync.bak`。缺失的插件会列出来，
   打开「拉取时安装缺失插件」就会在应用时顺手装回。
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

- 设置口令后，载荷用 **AES-256-GCM** 加密，密钥由 **scrypt** 从口令派生。
  网盘和 WebDAV 服务商只看得到密文。
- **口令是可选的。** 没有口令（或关闭加密）时载荷以明文上传，推送结果和
  `mini_sync_status` 都会明确写 `PLAINTEXT`；开启 `includeCredentials` 时明文里就有 API Key。
- WebDAV 密码与口令存在 DSH 凭据库（`.credentials.yaml`），不写入 `cordis.patch.yml`，
  也不进入载荷元数据。
- 口令错误会明确报错，不会返回垃圾数据。
- 只有 `includeCredentials` 为真时才带上 `.credentials.yaml`；有口令时它与其余内容受同一层加密保护。
- 真正的秘密是口令：任何同时拿到远端文件和口令的人就拿到了你的 API Key。

---

## 开发

```bash
node test/e2e.mjs        # 95 项：宿主侧核心逻辑，本地起 WebDAV 桩，无需联网
node test/client.mjs     # 50 项：客户端半区，含「启动不得抛错」、完整渲染与主题 token 回归
```

`e2e` 覆盖加密与明文两条路径、口令缺失时的降级、远端单文件结构、对话隔离、
演练不写盘、冲突处理、保留策略裁剪、跨系统 link 剔除、供应商白名单、跨机合并、
Base URL 改写与 loopback 提示、插件清单与 `github:` 安装源、缺失插件装回、
本机链接保留、远端文件列表与删除（含路径穿越拒绝），以及页面所用的两个接口载体
（均含跨源拒绝与口令不外泄）。

`client` 用模拟的模块表加载 `client.js`，断言工厂函数在求值阶段不抛错
（客户端模块一旦在 boot 阶段抛错，整个 Web 启动会失败）、只 require `react`、
正确注册 `settings.section`，样式以组件内 `<style>` 元素下发而非全局注入，
并且只使用 Harness 真正定义的 `--dsw-alias-*` 主题 token——之前用错 token 是
深色模式输入框黑底黑字的根因。

### 页面如何找到宿主

设置页是 `settings.section` 里的一个组件，不引入任何 Harness Client 包，
而是通过两个载体之一调用本包的 Host 半区：

1. `/api/dsh-mini-sync` —— 共享 `/api` 通道，桌面版渲染器（`dsh-app://` 自定义协议）
   本来就靠它访问宿主；
2. `/dsh-mini-sync/api` —— 直接挂在 web server 上的路由。

页面按此顺序尝试，成功后记住可用入口；两个都失败时会把尝试过的 URL 和
HTTP 状态一并显示出来，便于定位。

宿主侧用 `ctx.inject` 等待 `webServer` / `connection` / `tools` / `commands`
就绪后再注册——在桌面版组合里这些服务晚于本插件激活，用 `ctx.get()` 在
`apply` 阶段读取会拿到 `undefined` 并静默跳过注册。

### 启动保护会收起 patch 层

如果 DSH 因为某个第三方插件无法启动，而你选了「禁用第三方插件并重启」，
它会把这个 profile 的 `cordis.patch.yml` 收起，只留下最小行集，
完整内容存成 `cordis.patch.yml.bak-<时间戳>`。恢复：

```bash
node test/restore-patch.mjs [profile]
```

它把备份里的完整行集写回，同名行以当前文件为准，因此后写入的偏好值不会丢。

## 许可

MIT