# dsh-plugin-cfr

把 `cfr` 与 `rg` 注册为 DSH 的模型工具，给 Agent 一套完整的 jar 反编译体验：反编译一次、全文检索、按类读取。

cfr.jar 已随插件分发（`vendor/cfr.jar`，CFR 0.152，MIT 许可证），rg 由 `@vscode/ripgrep` 依赖提供，系统里只需要有 `java`。

## 工具

| 工具 | 作用 |
| --- | --- |
| `jar_decompile` | 把整个 jar 反编译到缓存目录，返回目录与 Java 文件数。同一个 jar 只真正编译一次，之后直接命中缓存。 |
| `jar_search` | 在反编译源码里用 ripgrep 做正则检索，返回 `文件:行号:内容`；jar 未反编译时自动先反编译。 |
| `jar_read` | 按类名读取源码，支持全限定名、内部名与短名，按行返回并可用 `offset` / `limit` 翻页；缓存缺失时即时反编译单个类。 |

会话工作目录用于解析相对路径，所以 `jar_read { jar: "lib/foo.jar", className: "Bar" }` 直接可用。

## 缓存

反编译结果按 jar 的路径与内容指纹落在 `$DSH_HOME/cache/jar-decompile/<jar 名>-<指纹>/`，跨会话、跨工作区复用。jar 内容变化会生成新目录，旧目录可随时删除。

## 配置

默认无需配置。要换 cfr 版本、调整缓存位置或换 ripgrep 时，在 profile 的 `cordis.patch.yml` 里覆盖 `jar-cfr` 行的 `config`：

```yaml
- id: jar-cfr
  config:
    cacheDir: D:\cache\jar-decompile
    javaPath: java
    cfrJar: D:\tools\cfr-0.152.jar
    rgPath: ''
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `cacheDir` | `$DSH_HOME/cache/jar-decompile` | 反编译缓存根目录 |
| `javaPath` | `java` | 启动 cfr 用的 java |
| `cfrJar` | 内置 `vendor/cfr.jar` | 想换版本时给出 cfr.jar 的绝对路径 |
| `rgPath` | 内置 `@vscode/ripgrep` | 想换 ripgrep 时给出可执行文件路径 |

## 依赖

- `java`：PATH 上可用，或用 `javaPath` 指定。
- `rg`：由 `@vscode/ripgrep` 依赖提供；依赖缺失时回退到 PATH 上的 `rg`。
- `cfr.jar`：已内置，无需单独安装。

## 安装

先在插件目录安装依赖：

```
pnpm install
```

再在 DSH 里用插件管理安装本目录的 bundle：

```
plugin_manager action=install_bundle target=<本目录绝对路径>
```
