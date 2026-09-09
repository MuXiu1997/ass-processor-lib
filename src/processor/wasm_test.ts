import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1.0.14'
import { join } from 'jsr:@std/path@1.1.3'
import { BatchProcessor, process, type ProcessConfig } from './index.ts'
import { scanFonts, WasmBackend, WasmBackendError } from './wasm-backend.ts'
import { TempDirCache } from './temp-dir-cache.ts'

const fontFixture = Deno.env.get('ASS_PROCESSOR_TEST_FONT')
const fontFamily = Deno.env.get('ASS_PROCESSOR_TEST_FONT_FAMILY') ?? 'Noto Sans'
const subtitle = `[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontFamily},24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Hello
`

Deno.test({
  name:
    'final batch bytes have one BOM, preserve backend output and expose a separate file hash',
  ignore: !fontFixture,
  async fn() {
    const root = await Deno.makeTempDir()
    const backend = new WasmBackend()
    const encoder = new TextEncoder()
    const hash = async (bytes: Uint8Array<ArrayBuffer>) =>
      Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
        .map((byte) => byte.toString(16).padStart(2, '0')).join('')
    try {
      const font = join(root, 'fixture.ttf')
      await Deno.copyFile(fontFixture!, font)
      await Deno.writeTextFile(join(root, 'episode.mkv'), '')
      const body = subtitle.replace(
        '[Script Info]\n',
        '[Script Info]\n; 中文・日本語\uFEFF\n',
      )
        .replaceAll('\n', '\r\n')
      const baseline = await backend.process([font], encoder.encode(body))
      assert(baseline.subtitle.includes('[Fonts]'))
      const configs: ProcessConfig[] = []
      const sources: Uint8Array<ArrayBuffer>[] = []
      const prepared: string[] = []
      const transforms = [
        undefined,
        (text: string) => text,
        async (text: string) => text,
        (text: string) => '\uFEFF' + text,
        async (text: string) => '\uFEFF\uFEFF' + text,
      ]
      for (const count of [0, 1, 2]) {
        for (const transform of transforms) {
          const index = configs.length
          const source = '\uFEFF'.repeat(count) + body
          sources.push(encoder.encode(source))
          prepared.push(transform ? await transform(body) : source)
          await Deno.writeFile(join(root, `${index}.ass`), sources[index])
          configs.push({
            fontDir: root,
            subtitleDir: root,
            subtitleGlob: `${index}.ass`,
            outputDir: root,
            videoGlob: 'episode.mkv',
            outputSuffix: `.${index}.out.ass`,
            subtitleTransform: transform,
          })
        }
      }
      // Explicit decoding also loses an input BOM before the final output layer.
      configs.push({
        ...configs[5],
        subtitleEncoding: 'utf-8',
        outputSuffix: '.decoded.out.ass',
      })
      sources.push(sources[5])
      prepared.push(body)
      const logFile = join(root, 'batch.log')
      const { results } = await process(configs, { logFile })
      assertEquals(results.length, configs.length)
      const log = await Deno.readTextFile(logFile)
      const expected = encoder.encode('\uFEFF' + baseline.subtitle)
      for (const [index, result] of results.entries()) {
        assert(result.success)
        const bytes = await Deno.readFile(result.outputFile)
        // Full equality covers CRLF, interior U+FEFF, all body text and font attachments.
        assertEquals(bytes, expected)
        new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        assertEquals(result.outputSha256, await hash(bytes))
        const raw = await backend.process(
          [font],
          encoder.encode(prepared[index]),
        )
        assertEquals(result.report!.output_sha256, raw.report.output_sha256)
        assertEquals(
          result.report!.input_sha256,
          await hash(encoder.encode(prepared[index])),
        )
        assert(log.includes(JSON.stringify(result.report, null, 2)))
        assert(
          log.includes(
            JSON.stringify({
              outputFile: result.outputFile,
              outputSha256: result.outputSha256,
            }),
          ),
        )
        assertEquals(
          await Deno.readFile(join(root, configs[index].subtitleGlob)),
          sources[index],
        )
      }
      assert(results[0].outputSha256 !== results[0].report!.output_sha256)
      assertEquals(results[5].outputSha256, results[5].report!.output_sha256)
      const repeated = await new BatchProcessor({ disableLog: true }).process(
        configs[0],
      )
      assertEquals(repeated.results[0].outputSha256, results[0].outputSha256)
      assertEquals(
        await Deno.readFile(repeated.results[0].outputFile),
        expected,
      )
    } finally {
      await backend.close()
      await Deno.remove(root, { recursive: true })
    }
  },
})

Deno.test('font scanning preserves directory priority, sorts and rejects WOFF', async () => {
  const root = await Deno.makeTempDir()
  try {
    const first = join(root, 'first')
    const second = join(root, 'second')
    await Deno.mkdir(first)
    await Deno.mkdir(second)
    for (
      const path of [
        join(first, 'z.TTF'),
        join(first, 'a.otc'),
        join(second, 'b.otf'),
      ]
    ) await Deno.writeFile(path, new Uint8Array())
    assertEquals(await scanFonts([first, second]), [
      join(first, 'a.otc'),
      join(first, 'z.TTF'),
      join(second, 'b.otf'),
    ])
    await Deno.writeFile(join(second, 'bad.woff2'), new Uint8Array())
    await assertRejects(
      () => scanFonts([second]),
      WasmBackendError,
      '不支持字体格式',
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('cache separates font and subtitle filters for a shared source', async () => {
  const root = await Deno.makeTempDir()
  const cache = new TempDirCache()
  try {
    await Deno.writeTextFile(join(root, 'a.ass'), subtitle)
    await Deno.writeFile(join(root, 'a.ttf'), new Uint8Array())
    await cache.getOrPrepare(root, 'font', { allowedExtensions: ['.ttf'] })
    const directory = await cache.getOrPrepare(root, 'subtitle', {
      allowedExtensions: ['.ass'],
    })
    assertEquals(await Deno.readTextFile(join(directory, 'a.ass')), subtitle)
  } finally {
    await cache.cleanup()
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('Worker propagates INPUT errors and close is idempotent', async () => {
  const backend = new WasmBackend()
  try {
    const error = await assertRejects(
      () => backend.process([], new TextEncoder().encode('invalid')),
      WasmBackendError,
    )
    assertEquals(error.code, 'INPUT')
    await assertRejects(
      () => backend.process([], new TextEncoder().encode('invalid again')),
      WasmBackendError,
    )
  } finally {
    await backend.close()
  }
  await backend.close()
  await assertRejects(
    () => backend.process([], new Uint8Array()),
    WasmBackendError,
    '已关闭',
  )
})

Deno.test('Worker timeout terminates the instance and rejects future requests', async () => {
  const backend = new WasmBackend(1)
  try {
    const error = await assertRejects(
      () => backend.process([], new TextEncoder().encode(subtitle)),
      WasmBackendError,
    )
    assertEquals(error.code, 'TIMEOUT')
    const closed = await assertRejects(
      () => backend.process([], new Uint8Array()),
      WasmBackendError,
    )
    assertEquals(closed.code, 'CLOSED')
  } finally {
    await backend.close()
  }
})

Deno.test({
  name:
    'real WASM batch transforms and writes subtitles; font-set switching does not retain fonts',
  ignore: !fontFixture,
  async fn() {
    const root = await Deno.makeTempDir()
    const backend = new WasmBackend()
    try {
      const font = join(root, 'NotoSans-Regular.ttf')
      await Deno.copyFile(fontFixture!, font)
      const bytes = new TextEncoder().encode(subtitle)
      const first = await backend.process([font], bytes)
      assert(first.subtitle.includes('[Fonts]'))
      assertEquals(
        (await backend.process([font], bytes)).report.output_sha256,
        first.report.output_sha256,
      )
      await assertRejects(() => backend.process([], bytes), WasmBackendError)
      assert((await backend.process([font], bytes)).report.fonts.length > 0)

      await Deno.writeTextFile(join(root, 'input.ass'), subtitle)
      await Deno.writeTextFile(join(root, 'episode.mkv'), '')
      const processor = new BatchProcessor({
        disableLog: true,
      })
      const config = {
        fontDir: root,
        subtitleDir: root,
        subtitleGlob: 'input.ass',
        outputDir: root,
        videoGlob: 'episode.mkv',
        outputSuffix: '.sc.ass',
        subtitleTransform: async (text: string) =>
          text.replace('Hello', 'World'),
      }
      const { results } = await processor.process([config, {
        ...config,
        outputSuffix: '.tc.ass',
      }])
      assertEquals(results.length, 2)
      assert(
        results.every((result) =>
          result.success && result.report!.fonts.length > 0
        ),
      )
      assert(
        (await Deno.readTextFile(join(root, 'episode.sc.ass'))).includes(
          'World',
        ),
      )
      assertEquals(await Deno.readTextFile(join(root, 'input.ass')), subtitle)
      // A fresh batch on the same processor must recreate the terminated Worker.
      assertEquals((await processor.process(config)).results[0].success, true)
      assertEquals(
        (await process(config, { disableLog: true })).results[0].success,
        true,
      )
      await Deno.writeTextFile(join(root, 'invalid.ass'), 'invalid')
      await assertRejects(
        () =>
          processor.process([
            {
              ...config,
              subtitleGlob: 'invalid.ass',
              outputSuffix: '.bad.ass',
            },
            { ...config, outputSuffix: '.skipped.ass' },
          ]),
        Error,
        '批处理失败',
      )
      await assertRejects(
        () => Deno.stat(join(root, 'episode.bad.ass')),
        Deno.errors.NotFound,
      )
      await assertRejects(
        () => Deno.stat(join(root, 'episode.skipped.ass')),
        Deno.errors.NotFound,
      )
      assertEquals((await processor.process(config)).results[0].success, true)
    } finally {
      await backend.close()
      await Deno.remove(root, { recursive: true })
    }
  },
})
