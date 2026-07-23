import {
  assertEquals,
  assertNotEquals,
  assertRejects,
} from 'jsr:@std/assert@1.0.14'
import { join } from 'jsr:@std/path@1.1.3'

import { withPreparedSubtitle } from './subtitle.ts'

async function withSubtitleFile<T>(
  content: Uint8Array,
  callback: (file: string) => T | Promise<T>,
): Promise<T> {
  const tempDir = await Deno.makeTempDir({ prefix: 'subtitle_test_' })
  const file = join(tempDir, 'subtitle.ass')

  try {
    await Deno.writeFile(file, content)
    return await callback(file)
  } finally {
    await Deno.remove(tempDir, { recursive: true })
  }
}

Deno.test('withPreparedSubtitle uses the original file without options', async () => {
  const content = new TextEncoder().encode('原始字幕')

  await withSubtitleFile(content, async (file) => {
    await withPreparedSubtitle(file, {}, (preparedFile) => {
      assertEquals(preparedFile, file)
    })
  })
})

Deno.test('withPreparedSubtitle converts GB18030 content to a UTF-8 working copy', async () => {
  const sourceBytes = new Uint8Array([0xce, 0xd2, 0x0d, 0x0a])
  let preparedFile = ''

  await withSubtitleFile(sourceBytes, async (file) => {
    await withPreparedSubtitle(
      file,
      { encoding: 'gb18030' },
      async (currentPreparedFile) => {
        preparedFile = currentPreparedFile
        assertNotEquals(preparedFile, file)
        assertEquals(await Deno.readTextFile(preparedFile), '我\r\n')
      },
    )

    assertEquals(await Deno.readFile(file), sourceBytes)
    await assertRejects(() => Deno.stat(preparedFile), Deno.errors.NotFound)
  })
})

Deno.test('withPreparedSubtitle transforms UTF-8 content without changing the source', async () => {
  const source = 'Style: Default,Arial\r\n'
  const sourceBytes = new TextEncoder().encode(source)

  await withSubtitleFile(sourceBytes, async (file) => {
    await withPreparedSubtitle(
      file,
      {
        transform: (content) => content.replace('Arial', 'Example Font'),
      },
      async (preparedFile) => {
        assertEquals(
          await Deno.readTextFile(preparedFile),
          'Style: Default,Example Font\r\n',
        )
      },
    )

    assertEquals(await Deno.readTextFile(file), source)
  })
})

Deno.test('withPreparedSubtitle decodes before applying the transform', async () => {
  const sourceBytes = new Uint8Array([0xce, 0xd2])

  await withSubtitleFile(sourceBytes, async (file) => {
    await withPreparedSubtitle(
      file,
      {
        encoding: 'gb18030',
        transform: (content) => {
          assertEquals(content, '我')
          return '你'
        },
      },
      async (preparedFile) => {
        assertEquals(await Deno.readTextFile(preparedFile), '你')
      },
    )
  })
})

Deno.test('withPreparedSubtitle rejects unsupported encodings', async () => {
  const content = new TextEncoder().encode('subtitle')

  await withSubtitleFile(content, async (file) => {
    await assertRejects(
      () =>
        withPreparedSubtitle(
          file,
          { encoding: 'not-an-encoding' },
          () => undefined,
        ),
      Error,
      '不支持的字幕编码: not-an-encoding',
    )
  })
})

Deno.test('withPreparedSubtitle rejects malformed encoded content', async () => {
  const malformedBytes = new Uint8Array([0x81])

  await withSubtitleFile(malformedBytes, async (file) => {
    await assertRejects(
      () =>
        withPreparedSubtitle(
          file,
          { encoding: 'gb18030' },
          () => undefined,
        ),
      Error,
      '字幕内容无法按 gb18030 解码',
    )
  })
})
