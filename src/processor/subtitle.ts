import { basename, join } from 'jsr:@std/path@1.1.3'

import { withTempDir } from '../utils/temp-dir.ts'

export type SubtitleTransform = (
  content: string,
) => string | Promise<string>

/** Serialize the final ASS once: exactly one leading BOM, no other text changes. */
export async function serializeSubtitleOutput(content: string): Promise<{
  bytes: Uint8Array<ArrayBuffer>
  outputSha256: string
}> {
  const bytes = new TextEncoder().encode(
    '\uFEFF' + content.replace(/^\uFEFF+/, ''),
  )
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const outputSha256 = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')
  return { bytes, outputSha256 }
}

export interface PrepareSubtitleOptions {
  /** 原始字幕文本编码；未设置时按 UTF-8 读取 */
  encoding?: string
  /** 对移除开头 BOM 的内容进行转换；最终文件 BOM 由输出层统一负责 */
  transform?: SubtitleTransform
}

function decodeSubtitle(bytes: Uint8Array, encoding: string): string {
  let decoder: TextDecoder

  try {
    decoder = new TextDecoder(encoding, { fatal: true })
  } catch (error) {
    throw new Error(`不支持的字幕编码: ${encoding}`, { cause: error })
  }

  try {
    return decoder.decode(bytes)
  } catch (error) {
    throw new Error(`字幕内容无法按 ${encoding} 解码`, { cause: error })
  }
}

/**
 * 根据配置解码并转换字幕，在 UTF-8 临时工作副本上执行后续处理。
 *
 * 未指定编码和转换函数时直接使用输入文件，避免不必要的复制。
 */
export async function withPreparedSubtitle<T>(
  inputFile: string,
  options: PrepareSubtitleOptions,
  callback: (preparedFile: string) => T | Promise<T>,
): Promise<T> {
  if (options.encoding === undefined && !options.transform) {
    return await callback(inputFile)
  }

  return await withTempDir('assfonts_subtitle_', async (tempDir) => {
    const encoding = options.encoding ?? 'utf-8'
    const bytes = await Deno.readFile(inputFile)
    let content = decodeSubtitle(bytes, encoding)

    if (options.transform) {
      content = await options.transform(content.replace(/^\uFEFF+/, ''))
    }

    const preparedFile = join(tempDir, basename(inputFile))
    await Deno.writeTextFile(preparedFile, content)

    return await callback(preparedFile)
  })
}
