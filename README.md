# dsh-mini-sync

**Minimal DeepSeek Harness configuration sync between your own machines — through your own WebDAV.**

Your model providers, API keys, base URLs, plugin list and settings ride along.
Your conversations never do.

One encrypted file on the remote. Adjustable sync interval. Adjustable retention.

---

## Why this exists

DSH configuration lives in a few text files, but they are scattered and partly machine-specific.
Existing backup plugins solve *migration* — they pack your whole `$DSH_HOME`, sessions included,
and pile snapshots onto the remote. That is the wrong shape when all you want is:

- the same providers and API keys on every machine,
- the same plugin list,
- **not** your chat history on someone else's disk,
- **not** a growing pile of archives in your WebDAV folder.

`dsh-mini-sync` does exactly that and nothing else.

|  | dsh-mini-sync |
|---|---|
| Conversations / sessions | never touched |
| Remote layout | one file: `config.json` (plus `history/` only if you ask for it) |
| Retention | `keepVersions: 0` → single file, always overwritten in place |
| Sync interval | `intervalMinutes` — 0 (manual only) up to any cadence you like |
| API keys | included, sealed with AES-256-GCM before upload |
| Runtime dependencies | none (Node built-ins only) |

---

## What travels

| Payload key | Source | Notes |
|---|---|---|
| `profile/cordis.patch.yml` | `$DSH_HOME/profiles/<profile>/` | providers, models, base URLs, headers, UI config |
| `profile/package.json` | same | bundle list + npm plugins |
| `settings.yaml` / `settings.json` | `$DSH_HOME/` | global settings |
| `AGENTS.md` | `$DSH_HOME/` | global instructions |
| `skills/**` | `$DSH_HOME/skills/` | text files only, opt-out |
| `.credentials.yaml` | `$DSH_HOME/` | **encrypted**, opt-out |

Never uploaded: `sessions/`, `storages/`, attachments, workspace registries, `node_modules`.

### Machine-local paths are handled, not copied

A profile's `package.json` often carries `link:` dependencies pointing at an absolute path
that only exists on the machine that wrote it. Shipping that to another OS breaks the profile.
On push, those entries are dropped and reported; the `dsh.bundle` list still travels, so
`dsh plugin add` restores the plugin on the target machine.

Cross-platform reminders and path rewriting are available through `pathMap`:

```json
[{ "from": "C:\\Users\\alice\\", "to": "/Users/alice/" }]
```

### Only *your* providers travel

Tools and gateways often write their own providers and models into the same
`cordis.patch.yml`. Without a scope, all of it would land on every machine.

`syncProviders` is a whitelist. Empty means "sync everything"; once set, only the named
entries are placed in the uploaded payload:

```yaml
syncProviders:
  - my-provider                   # the whole provider, every model
  - my-provider/Qwen/qwen3-max    # a single model (model ids may contain slashes)
```

The upload is scoped, **not** your local file — filtering never edits `cordis.patch.yml`
on the machine you pushed from.

On pull, the merge is equally narrow: only the whitelisted providers are taken from the
remote, and any other provider already on that machine is kept. A model present locally
but absent from the remote is preserved too, so a narrower whitelist elsewhere cannot
silently delete models here.

### Base URLs that only work on one machine

A gateway bound to `127.0.0.1:<port>` is reachable only from the machine that wrote it.
What it means for you depends on your setup:

- **Same port on every machine** (a locally installed gateway) → `127.0.0.1:10100` is
  correct on each machine, so leave the URL alone. Push warns when it sees a loopback
  address, so this is a deliberate choice rather than an accident.
- **One shared gateway** (on a NAS, a LAN host, or Tailscale) → rewrite it while pushing:

```yaml
rewriteBaseURL:
  - { match: '127.0.0.1:10100', replace: 'gateway.lan:10100' }
```

Nothing about loopback is hard-coded anywhere in the plugin: no port, no host, no
assumption that a local gateway exists at all.

---

## Install

```bash
dsh plugin --profile web add github:<owner>/dsh-mini-sync
```

Then restart DSH. A **Mini Sync** row appears in Settings → Plugins.

---

## Configure

The whole setup is one tool call — this is the "minimum prompts" path:

> Configure mini sync: WebDAV https://dav.example.com/dsh, user me, password ***, passphrase ***,
> interval every 30 minutes, keep 0 versions.

That maps to `mini_sync_setup`:

| Parameter | Meaning |
|---|---|
| `url` | WebDAV base URL |
| `username` / `password` | Basic auth; password goes to the DSH credential store |
| `passphrase` | encryption passphrase; stored as a credential, never in a config file |
| `remoteDir` | folder under `url` (default `dsh-mini-sync`) |
| `intervalMinutes` | auto-push cadence; `0` = manual only |
| `keepVersions` | `0` = one file overwritten in place; `N` = keep last N in `history/` |
| `includeCredentials` | include `.credentials.yaml` (encrypted) |
| `includeSkills` | include `skills/` |
| `pullOnStart` | apply the remote config when the plugin loads |
| `pathMap` | `{from,to}` path rewrites applied while pushing |
| `syncProviders` | whitelist of `provider` or `provider/model` entries; empty = all |
| `rewriteBaseURL` | `{match,replace}` rewrites for machine-specific gateway addresses |

The same values can be written into the profile patch if you prefer declarative config:

```yaml
- insert:
    - id: mini-sync
      name: 'dsh-mini-sync'
      config:
        url: 'https://dav.example.com/dsh'
        username: 'me'
        remoteDir: dsh-mini-sync
        intervalMinutes: 30
        keepVersions: 0
```

Secrets stay in `~/.dsh/.credentials.yaml` under `DSH_SYNC_WEBDAV_PASSWORD` and
`DSH_SYNC_PASSPHRASE` either way.

---

## Use

| Tool | What it does |
|---|---|
| `mini_sync_push` | upload this machine's config as one encrypted file |
| `mini_sync_pull` | compare and (with `apply`) write the remote config |
| `mini_sync_status` | target, interval, retention, last push/pull, what would travel |
| `mini_sync_setup` | change any setting, including the interval and retention |

Or from chat: `/sync status`, `/sync push`, `/sync pull`, `/sync pull apply`.

### Day-to-day

1. Machine A: `mini_sync_push`.
2. Machine B (new machine): `mini_sync_setup` with the same url + passphrase, then
   `mini_sync_pull` to preview, then `apply: true`. A `.dsh-mini-sync.bak` is written next to
   every replaced file.
3. Change an API key later: push again from wherever you changed it. With `keepVersions: 0`
   the remote file is simply replaced — nothing accumulates.

### Conflicts

`pull` is a three-way comparison against the last synced state:

- remote changed, local untouched → **updated**
- local file exists but has no sync baseline (fresh device) → **adopted**
- local changed since the last sync → **conflict**, left alone
- `force: true` → overwrite anyway, after writing a `.bak`

Dry run is the default: `pull` writes nothing unless you pass `apply: true`.

---

## Security

- Payload is encrypted with **AES-256-GCM**, key derived by **scrypt** from your passphrase.
  The remote and your WebDAV provider only ever see ciphertext.
- The WebDAV password and passphrase live in the DSH credential store
  (`.credentials.yaml`), never in `cordis.patch.yml` and never in the payload metadata.
- A wrong passphrase fails loudly instead of returning garbage.
- `.credentials.yaml` is included **only** when `includeCredentials` is true, and it is
  protected by the same envelope as everything else.
- Treat the passphrase as the real secret: anyone with the remote file *and* the passphrase
  has your API keys.

---

## Develop

```bash
node test/e2e.mjs     # 41 checks; spins a local WebDAV stub, no network needed
```

The test suite covers encryption, single-file remote layout, conversation exclusion,
dry-run safety, conflict handling, retention pruning, cross-OS link stripping, provider
whitelisting, cross-machine merge, base-URL rewriting and the loopback warning.

## License

MIT