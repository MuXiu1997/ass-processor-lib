import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1.0.14'
import { join } from 'jsr:@std/path@1.1.3'
import { BatchProcessor, process } from './index.ts'
import { scanFonts, WasmBackend, WasmBackendError } from './wasm-backend.ts'
import { TempDirCache } from './temp-dir-cache.ts'

const fontFixture = Deno.env.get('ASS_PROCESSOR_TEST_FONT')
const subtitle = `[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Hello
`

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
