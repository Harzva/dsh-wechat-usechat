# DSH WeChat via UseChat

An opt-in, local DSH bundle wrapping the published [UseChat](https://github.com/CosmosShadow/usechat) 0.1.0 CLI. It exposes `usechat_doctor`, `usechat_read`, and `usechat_send_text`. It requires Node.js 22.19+ for this DSH integration. It does not install UseChat Helper, read chats at startup, send messages at startup, or run package lifecycle scripts. This repository is distributed through GitHub, not npm.

## Install in an isolated DSH profile

Pin a reviewed Git commit instead of a moving branch. For a local checkout, replace the Git URL with its absolute directory. The DSH host must explicitly admit the bundle and enable its capabilities. No model should be able to install a bundle or alter host policy.

```sh
export DSH_HOME=/absolute/private/dsh-home
dsh plugin --profile sdk-minimal add 'git+https://github.com/Harzva/dsh-wechat-usechat.git#<reviewed-commit>' --ignore-scripts
dsh --profile sdk-minimal --dump-config
```

DSH 0.2.1-rc.2 reads `package.json` `dsh.bundle.patch` and inserts the tool plugin from `cordis.patch.yml`. A host using the OpenBot marketplace must first support Git sources; its current bridge prepares npm sources only. A GitHub listing does not imply that OpenBot can install it online.

## Host configuration

Set these in the environment of the **DSH process**, not in a model prompt. Use a separate private UseChat config and data directory per profile. The plugin refuses to use UseChat's default home config.

| Variable | Meaning |
| --- | --- |
| `USECHAT_DSH_CONFIG` | Required absolute path to an existing UseChat JSON config. |
| `USECHAT_DSH_ALLOWED_CHATS` | Required JSON array of exact chat names, for example `["Team chat"]`. Empty array denies chat access. |
| `USECHAT_DSH_WRITE_ENABLED` | Set to `1` only when ready to allow approved sends. Default is off. |
| `USECHAT_DSH_RECEIPTS_DIR` | Required for sending: existing, real, private `0700` directory for durable receipts. |
| `USECHAT_DSH_UI_LEASE_DIR` | Required for doctor/read/send: existing, real, private `0700` directory shared by every BOT using this desktop. |

A host can instead set the Cordis plugin row's `config` object with `configPath`, `allowedChats`, `writeEnabled`, `receiptDir`, and `uiLeaseDir`. These fields override corresponding environment variables and are rejected if their names or types are invalid. For example, a trusted profile patch may replace the plugin row with:

```yaml
- id: harzva-wechat-usechat
  name: '@harzva/dsh-wechat-usechat'
  config:
    configPath: /absolute/private/usechat/config.json
    allowedChats: ['Team chat']
    writeEnabled: false
    uiLeaseDir: /absolute/private/usechat/ui-lease
```

Create the lease directory before boot with `mkdir -m 700 /absolute/private/usechat/ui-lease`; use one path across all DSH processes that share this visible desktop. For sending, create a separate private receipt directory and set `receiptDir`. A held `.active` lease is never removed automatically after timeout or an uncertain send. Inspect the UI and receipts before manually clearing it.

Prepare UseChat separately, using its [upstream setup guide](https://github.com/CosmosShadow/usechat#快速开始). `doctor` may start Helper and probe or restore the visible WeChat window when a valid Helper is configured; do it only on a desktop you intend to inspect. For example, in a local checkout after `npm install --ignore-scripts`:

```sh
USECHAT_CLI=./node_modules/@shennian/usechat/dist/index.js
export USECHAT_DSH_CONFIG=/absolute/private/usechat/config.json
node "$USECHAT_CLI" --config "$USECHAT_DSH_CONFIG" init
node "$USECHAT_CLI" --config "$USECHAT_DSH_CONFIG" config set dataDir /absolute/private/usechat/data
node "$USECHAT_CLI" --config "$USECHAT_DSH_CONFIG" config set helper.path '/absolute/path/to/UseChat Helper.app'
node "$USECHAT_CLI" --config "$USECHAT_DSH_CONFIG" config set model.provider openai-compatible
node "$USECHAT_CLI" --config "$USECHAT_DSH_CONFIG" config set model.baseUrl https://your-vision-endpoint.example/v1
node "$USECHAT_CLI" --config "$USECHAT_DSH_CONFIG" config set model.name your-vision-model
node "$USECHAT_CLI" --config "$USECHAT_DSH_CONFIG" config set model.apiKeyEnv YOUR_MODEL_KEY_ENV
node "$USECHAT_CLI" --config "$USECHAT_DSH_CONFIG" --json doctor
```

Obtain Helper from the upstream project or its publisher, verify its origin and integrity, then install it explicitly if needed with `usechat setup-helper --from <verified-artifact>`. This bundle never downloads or installs Helper. Give macOS Screen Recording, Accessibility and Automation permissions to the actual Helper/terminal where the upstream guide requires them. A vision provider may receive screenshots and OCR of the visible WeChat window. Keep model credentials in the named environment variable, not the JSON config.

## Safety and receipts

`usechat_read` takes only a host-allowed chat and a limit of 1–50. It fixes `--download never`. `usechat_send_text` supports text only, 1–4000 characters. Its built-in DSH pre-execute policy returns `ask` for every send; without an available approval service and answerer, DSH fails closed. After a one-shot approval, the adapter also requires the host write flag before using UseChat `--yes`. The `sdk-minimal` profile above is only an installation check; deploy sending in a DSH profile with a real approval answerer. Tool callers cannot choose executable paths, config paths, attachment paths, or Helper installation commands.

Before invoking UseChat for a send, the plugin creates and fsyncs a receipt. A successful CLI return records `submitted_unconfirmed` because UseChat 0.1.0 reports `sent-unconfirmed`, not recipient delivery. Timeout, cancellation or CLI failure records `uncertain`, keeps the `.active` lock, and blocks later sends. A repeated `requestId` never resends. The operator must inspect the actual chat and receipt before manually resolving an uncertain send; removing `.active` alone is insufficient if an `uncertain` receipt remains. Never automatically retry an uncertain send under a new ID.

The plugin serializes its own foreground UI calls and uses the shared lease across BOT processes. It is not an OS sandbox for third-party Node code, and unrelated desktop automation must honor that lease or stay idle. The host should keep this profile dedicated to UseChat work. No real WeChat read/send acceptance is claimed by the automated tests.

## Development

```sh
npm install --ignore-scripts
npm test
npm pack --dry-run --json
```

Runtime dependencies use exact versions; `package-lock.json` pins transitive dependencies for this repository. The Cordis peer dependency expresses the DSH 0.2.1-rc.2 compatibility range. See `NOTICE` for upstream attribution.
