import { copy, ensureDir, walk } from 'jsr:@std/fs@1.0.20'
import { basename, dirname, extname, join, relative } from 'jsr:@std/path@1.1.3'
import { ulid } from 'jsr:@std/ulid@1.0.0'
import { consola } from 'npm:consola@3.4.2'

import { extractArchive, isArchiveFile } from '../utils/extractors.ts'

/**
 * 按扩展名过滤复制目录，只复制匹配扩展名的文件，保留目录结构
 */
async function filteredCopy(
  src: string,
  dest: string,
  allowedExtensions: string[],
): Promise<void> {
  const lowerExts = new Set(allowedExtensions.map((e) => e.toLowerCase()))

  for await (const entry of walk(src, { includeDirs: false })) {
    const ext = extname(entry.name).toLowerCase()
    if (!lowerExts.has(ext)) continue

    const rel = relative(src, entry.path)
    const destPath = join(dest, rel)
    await ensureDir(dirname(destPath))
    await Deno.copyFile(entry.path, destPath)
  }
}

/**
 * 临时目录缓存管理器
 *
 * 用于管理临时目录的创建和清理，支持：
 * - 解压压缩文件到临时目录并缓存
 * - 复制文件/目录到临时目录并缓存
 * - 自动清理所有创建的临时目录
 *
 * 所有子目录都在一个共享的根临时目录下创建，清理时只需删除根目录即可
 */
export class TempDirCache {
  private cache = new Map<string, string>()
  private rootTempDir: string | null = null
  private subDirCount = 0

  /**
   * 确保根临时目录存在
   */
  private async ensureRootDir(): Promise<string> {
    if (!this.rootTempDir) {
      this.rootTempDir = await Deno.makeTempDir({
        prefix: 'assfonts_cache_',
      })
    }
    return this.rootTempDir
  }

  /**
   * 创建一个新的子目录
   */
  private async createSubDir(): Promise<string> {
    const rootDir = await this.ensureRootDir()
    const subDir = join(rootDir, ulid())
    await ensureDir(subDir)
    this.subDirCount++
    return subDir
  }

  /**
   * 获取或准备临时目录
   * 自动判断源路径是压缩包还是目录，选择解压或复制
   * @param sourcePath 源路径（压缩文件或目录）
   * @param description 描述（用于日志）
   * @param options.allowedExtensions 允许复制的文件扩展名（仅目录复制时生效），如 ['.ttf', '.otf']
   * @returns 临时目录路径
   */
  async getOrPrepare(
    sourcePath: string,
    description: string,
    options?: { allowedExtensions?: string[] },
  ): Promise<string> {
    const absolutePath = await Deno.realPath(sourcePath)
    const stat = await Deno.stat(absolutePath)

    const isArchive = stat.isFile && await isArchiveFile(absolutePath)
    const mode = isArchive ? 'extract' : 'copy'
    const cacheKey = `${mode}:${absolutePath}`

    if (this.cache.has(cacheKey)) {
      const icon = isArchive ? '📦' : '📁'
      const action = isArchive ? '解压' : '复制'
      consola.info(`${icon} 使用缓存的${action}目录: ${basename(sourcePath)}`)
      return this.cache.get(cacheKey)!
    }

    const subDir = await this.createSubDir()

    if (isArchive) {
      consola.info(`📦 解压${description}: ${basename(sourcePath)}`)
      await extractArchive(sourcePath, subDir)
    } else if (options?.allowedExtensions?.length) {
      consola.info(
        `📁 复制${description}（按扩展名过滤）: ${basename(sourcePath)}`,
      )
      await filteredCopy(absolutePath, subDir, options.allowedExtensions)
    } else {
      consola.info(`📁 复制${description}: ${basename(sourcePath)}`)
      await copy(absolutePath, subDir, { overwrite: true })
    }

    this.cache.set(cacheKey, subDir)
    return subDir
  }

  /**
   * 清理根临时目录（包含所有子目录）
   */
  async cleanup(): Promise<void> {
    if (this.rootTempDir) {
      try {
        await Deno.remove(this.rootTempDir, { recursive: true })
      } catch {
        // 忽略清理错误
      }
    }
    this.cache.clear()
    this.rootTempDir = null
    this.subDirCount = 0
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): { cached: number; subDirs: number } {
    return {
      cached: this.cache.size,
      subDirs: this.subDirCount,
    }
  }
}
