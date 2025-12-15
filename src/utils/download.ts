import { ensureDir } from 'jsr:@std/fs@1.0.20'
import { dirname } from 'jsr:@std/path@1.1.3'

/** 下载选项 */
export interface DownloadOptions {
  /** 请求头 */
  headers?: HeadersInit
  /** 超时时间（毫秒） */
  timeout?: number
}

/**
 * 下载文件到指定路径
 * @param url 下载地址
 * @param destPath 目标文件路径
 * @param options 下载选项
 * @returns 下载的文件路径
 */
export async function download(
  url: string,
  destPath: string,
  options: DownloadOptions = {},
): Promise<string> {
  const { headers, timeout } = options

  // 确保目标目录存在
  await ensureDir(dirname(destPath))

  // 创建 AbortController 用于超时控制
  const controller = new AbortController()
  const timeoutId = timeout
    ? setTimeout(() => controller.abort(), timeout)
    : undefined

  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`下载失败: ${response.status} ${response.statusText}`)
    }

    const file = await Deno.create(destPath)
    await response.body?.pipeTo(file.writable)

    return destPath
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`下载超时: ${url}`)
    }
    throw error
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}
