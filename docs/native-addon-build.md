# Native Addon 构建说明

> 版本：V1
> 日期：2026-06-19
> 范围：Windows 本机优先，Linux/macOS 保留 target 映射

## 1. 目标

Range Strata Binary 查询热路径依赖 Rust `napi-rs` native addon。V1 的目标是把本机 native addon 构建流程固化，避免不同平台靠人工记忆 target。

V1 优先保证：

- Windows x64 本机可重复构建
- Windows x64 固定使用 MSVC target
- native formatter/test 纳入 release 检查
- Linux/macOS target 映射先进入脚本，后续接 CI 时直接复用

## 2. 支持矩阵

| 平台 | Target | 产物 |
| --- | --- | --- |
| Windows x64 | `x86_64-pc-windows-msvc` | `preflop-storage-native.win32-x64-msvc.node` |
| Linux x64 glibc | `x86_64-unknown-linux-gnu` | `preflop-storage-native.linux-x64-gnu.node` |
| macOS Apple Silicon | `aarch64-apple-darwin` | `preflop-storage-native.darwin-arm64.node` |
| macOS Intel | `x86_64-apple-darwin` | `preflop-storage-native.darwin-x64.node` |

V1 暂不覆盖 Linux musl/Alpine、Linux arm64、Windows GNU、macOS universal binary。

## 3. 常用命令

按当前平台自动选择 target：

```powershell
bun run build:native
```

Windows x64 显式构建：

```powershell
bun run build:native:win
```

Linux/macOS 显式 target：

```bash
bun run build:native:linux
bun run build:native:mac:arm64
bun run build:native:mac:x64
```

native 检查：

```powershell
bun run check:native
```

发布前检查：

```powershell
bun run check:release
```

`check:release` 会执行 TypeScript 检查、ESLint、Bun 测试、Rust formatter 检查、Rust 测试和 Range Strata Binary standalone CRC 自检。

## 4. 构建脚本行为

入口：

```text
scripts/build-native.ts
```

默认行为：

- `win32/x64` -> `x86_64-pc-windows-msvc`
- `linux/x64` -> `x86_64-unknown-linux-gnu`
- `darwin/arm64` -> `aarch64-apple-darwin`
- `darwin/x64` -> `x86_64-apple-darwin`

脚本会执行：

```bash
bunx @napi-rs/cli build --platform --release --target <target>
```

构建结束后会检查对应 `.node` 文件是否存在。

可查看支持目标：

```powershell
bun run build:native -- --list-targets
```

可只打印命令不执行：

```powershell
bun run build:native -- --dry-run
```

## 5. Smoke Test

构建脚本本身由 `tests/native-build-script.test.ts` 覆盖，确保发布入口不会因为脚本参数或 target 映射变化而静默失效。

当前覆盖：

- `--list-targets` 能列出所有 V1 支持 target
- `--dry-run` 能生成正确的 napi-rs build 命令
- 支持 `bun run build:native -- --target ...` 这种参数分隔符写法
- 不支持的 target 会以非 0 退出并打印清晰错误

运行：

```powershell
bun test tests/native-build-script.test.ts
```

## 6. Windows 注意事项

Windows x64 必须使用：

```text
x86_64-pc-windows-msvc
```

不要使用默认 GNU target。默认 GNU target 可能触发：

```text
libnode.dll not found in any search path
```

这是因为 Windows GNU 链接路径需要 `libnode.dll`，而本机 Node/Bun 安装通常不提供该动态库。MSVC target 与当前仓库已验证路径一致。

建议环境：

- Rust stable
- Visual Studio C++ Build Tools
- Bun 1.3+

## 7. 发布约定

`.node` 是本机构建产物，当前仓库不提交这些二进制文件。发布或部署前，应在目标平台本机执行：

```powershell
bun run build:native
bun run check:release
```

Linux/macOS 在 V1 阶段只保留脚本和 target 映射；正式发布到这些平台前，需要在对应平台本机跑同样命令并确认 `.node` 产物可被 Bun 测试加载。

## 8. 后续阶段

V2 可以考虑：

- GitHub Actions 多平台构建矩阵
- npm prebuild/optional dependency 分发
- Linux arm64 与 musl 支持
- macOS universal binary
- native addon smoke test 独立脚本
