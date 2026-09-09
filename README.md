# ass-processor-lib

Deno ASS 字幕批处理：准备字体/字幕目录或压缩包、转换字幕、字体子集化和内嵌，并按视频文件命名输出。

## 使用

字幕处理仅使用 `@muxiu1997/assfonts-rs-wasm@0.1.0-beta.0`，
在 Deno module Worker 中执行，无需安装原生 assfonts：

```ts
import { process } from './src/processor/index.ts'

const { results } = await process({
  fontDir: './fonts',
  subtitleDir: './subtitles',
  subtitleGlob: 'episode01.ass',
  outputDir: './videos',
  videoGlob: 'episode01.mkv',
  outputSuffix: '.sc.ass',
  parseMode: 'strict',
  missingGlyphPolicy: 'warn',
}, {
  wasmTimeoutMs: 120_000,
})

console.log(results[0].report)
console.log(results[0].outputSha256) // 最终文件（包含 BOM）的 SHA-256
```

也可以使用 `new BatchProcessor().process(configs)`。
原有 `subtitleEncoding` 和异步 `subtitleTransform` 继续支持，转换在主线程执行。
单个处理器拒绝并发批次；批次内串行处理，遇到失败停止。成功结果附带 `report`，
日志记录结构化报告，控制台显示缺字警告。

## 输出编码与文件校验

所有成功输出的 ASS 都使用 UTF-8，且文件开头恰好一个 BOM（`EF BB BF`）。
无论输入有无 BOM、是否配置 `subtitleEncoding`、是否使用同步或异步变换，均执行此规则。
输出层仅规范化开头连续的 BOM，不改变后端返回的正文、换行、正文内部的 `U+FEFF` 或字体附件。
这是面向外挂 ASS 播放器兼容性的默认策略，不提供关闭选项；UTF-8 标准本身不要求 BOM。

`subtitleTransform` 接收严格解码并移除开头 BOM 的内容，只需返回修改后的文本，
无需手动补 BOM。现有返回一个或多个开头 BOM 的变换仍兼容，最终统一为一个。
非 UTF-8 输入仍需通过 `subtitleEncoding` 指定正确编码；不会猜测编码或修复已经乱码的内容。

成功结果中的 `outputSha256` 是实际写入文件的完整 UTF-8 字节（包含 BOM）的 SHA-256，
日志同时记录 `outputFile` 和 `outputSha256`。复制、安装或验收最终文件时应使用此字段。
`report` 保留原始 WASM 报告，不修改后端的哈希、字体信息或报告版本：

- `report.input_sha256` 对应实际送入后端的工作副本，可能与原始源文件不同。
- `report.output_sha256` 对应后端输出在最终 BOM 规范化之前的字节，可能与
  `outputSha256` 不同。

此前使用 `report.output_sha256` 校验最终文件的调用方应迁移到 `outputSha256`。
这项保证适用于本库的 `process()` 和 `BatchProcessor.process()` 文件输出；直接调用 WASM 后端仍遵循后端契约。
已生成的文件不会自动更新，固定导入旧提交的脚本也必须显式升级。
libass 强制 UTF-8 的渲染一致性不能替代 BOM 字节检查或实际播放器的自动编码识别复测。

## 后端与运行环境

每批使用一个 module Worker；相同字体文件集复用 engine，切换字体集重建。
按 `fontDir` 数组顺序及目录内路径排序注册字体，不自动加载系统字体。
超时覆盖 Worker 启动、字体注册和字幕处理，不包含宿主解压、扫描、转换和写出。
批次结束关闭 engine 并终止 Worker，fatal/超时直接终止 Worker。

WASM 接受 TTF/OTF/TTC/OTC，遇到 WOFF/WOFF2 报错。
字幕要求 UTF-8 ASS v4+；其他编码需通过 `subtitleEncoding` 转换。
不支持 SSA、SRT、已有 `[Fonts]` 等输入；`compatible` 也不代表支持所有 ASS 特性。
缺字 `warn` 不会补齐字形。完整真实字幕兼容验收尚未完成。

要求 Deno >=2.5.6。上游验证 Deno 2.5.6，本仓库本次验证 Deno 2.9.6。
缓存依赖后，处理不需要网络或子进程：

```sh
deno run --allow-read --allow-write --allow-env --allow-sys=cpus --deny-net --deny-run main.ts
```

`--allow-sys=cpus` 用于现有 fast-glob 依赖。读取权限也需覆盖 npm 缓存中的 WASM 文件。

## 验证

```sh
deno check src/processor/index.ts src/processor/wasm-worker.ts
deno test --allow-read --allow-write --allow-env --allow-sys=cpus --deny-net --deny-run src/processor
```

真实字体集成测试默认使用本地 Noto Sans Regular TTF：

```sh
ASS_PROCESSOR_TEST_FONT=/path/to/NotoSans-Regular.ttf deno test --allow-read --allow-write --allow-env --allow-sys=cpus --deny-net --deny-run src/processor
```

也可指定其他支持 `Hello` 和 `World` 字符的本地 TTF，并通过
`ASS_PROCESSOR_TEST_FONT_FAMILY` 提供其实际字体族名（默认 `Noto Sans`）。
未设置字体路径时，两项真实字体集成测试均跳过；其余测试仍执行。
