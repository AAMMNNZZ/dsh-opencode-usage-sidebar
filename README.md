# dsh-opencode-usage-sidebar

An OpenCode Go subscription usage card in the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) sidebar footer: the 5-hour, weekly and monthly windows at a glance, with a live countdown to the 5-hour reset.

把 OpenCode 订阅的 **5 小时 / 本周 / 本月** 用量显示在 DSH 侧栏底部，并在卡片标题旁实时倒计时到 5 小时窗口重置。

## What it shows

- Three rows — `5 小时`, `本周`, `本月` — each with the used percentage and a bar that turns warm at 70% and red at 90%.
- A live countdown after the `OpenCode` title (`1时58分`, `42分`, `42秒`), ticking every second and switching to `即将刷新` when the 5-hour window resets.
- Refreshes on the plugin's poll interval, after every assistant turn, and when the window regains focus.

## Install

```sh
# from this repository
dsh plugin --profile desktop add git+https://github.com/AAMMNNZZ/dsh-opencode-usage-sidebar.git

# or from a prebuilt tarball
dsh plugin --profile desktop add file:/path/to/dsh-opencode-usage-sidebar.tgz
```

Remove it with `dsh plugin --profile desktop remove dsh-opencode-usage-sidebar`.

## Configure the API key

The plugin reads the credential ref `OPENCODE_GO_API_KEY` from the DSH credential store at request time — the key is never part of this package and never reaches the browser.

The shortest path is the Settings → **Models** page: fill in the API key for the `opencode-go` provider. That stores the key under `refs: OPENCODE_GO_API_KEY` in `~/.dsh/.credentials.yaml`, which is exactly the ref this plugin resolves.

If you do not use an `opencode-go` provider, add the ref by hand:

```yaml
# ~/.dsh/.credentials.yaml
refs:
  OPENCODE_GO_API_KEY: "<your-key>"
```

## Options

Optional row config in your profile patch, or the matching environment variable:

| Row config | Environment variable | Default |
| --- | --- | --- |
| `endpoint` | `DSH_OPENCODE_USAGE_ENDPOINT` | `https://opencode.ai/zen/go/v1/usage` |
| `credentialRef` | `DSH_OPENCODE_USAGE_CREDENTIAL` | `OPENCODE_GO_API_KEY` |
| `pollIntervalSec` | `DSH_OPENCODE_USAGE_POLL` | `60` (minimum 15) |
| `cacheMs` | — | `15000` |

## How it works

The host half resolves the credential and performs the upstream `GET` itself — opencode.ai rejects that request from a page context. The browser half only polls the same-origin routes `/dsh-opencode-usage/api/usage` (JSON, cached) and `/dsh-opencode-usage/api/stream` (SSE, used to wake every open window after a turn ends).

Both halves are dependency-free: the host imports nothing, and the client uses only the `react` module the harness already provides, so a locally installed bundle needs no `node_modules`.

## License

MIT
