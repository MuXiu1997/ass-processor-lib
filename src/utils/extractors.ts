import { ensureDir, walk } from 'jsr:@std/fs@1.0.20'
import { basename, dirname } from 'jsr:@std/path@1.1.3'
import { join as posixJoin } from 'jsr:@std/path@1.1.3/posix'
import { ulid } from 'jsr:@std/ulid@1.0.0'

import _SevenZip, { type SevenZipModuleFactory } from 'npm:7z-wasm@1.2.0'
import { consola } from 'npm:consola@3.4.2'
import { fileTypeFromFile } from 'npm:file-type@21.1.1'

// Emscripten callMain returns an exit status; 7z-wasm declares it as void.
type SevenZipModule = Awaited<ReturnType<SevenZipModuleFactory>>
const SevenZip = _SevenZip as unknown as (
  ...args: Parameters<SevenZipModuleFactory>
) => Promise<Omit<SevenZipModule, 'callMain'> & { callMain(args: string[]): number }>

/**
 * 使用 file-type 检测文件类型（基于文件内容）
 */
export async function detectFileType(
  path: string,
): Promise<{ ext?: string; mime?: string } | undefined> {
  try {
    return await fileTypeFromFile(path)
  } catch {
    return undefined
  }
}

/**
 * 检查路径是否为 RAR 文件（基于文件内容）
 */
export async function isRarFile(path: string): Promise<boolean> {
  const type = await detectFileType(path)
  return type?.ext === 'rar'
}

/**
 * 检查路径是否为 ZIP 文件（基于文件内容）
 */
export async function isZipFile(path: string): Promise<boolean> {
  const type = await detectFileType(path)
  return type?.ext === 'zip'
}

/**
 * 检查路径是否为 7z 文件（基于文件内容）
 */
export async function is7zFile(path: string): Promise<boolean> {
  const type = await detectFileType(path)
  return type?.ext === '7z'
}

/**
 * 检查路径是否为 tar 文件（基于文件内容）
 */
export async function isTarFile(path: string): Promise<boolean> {
  const type = await detectFileType(path)
  return type?.ext === 'tar' || type?.ext === 'tar.gz'
}

/**
 * 检查路径是否为压缩文件（基于文件内容）
 */
export async function isArchiveFile(path: string): Promise<boolean> {
  const type = await detectFileType(path)
  if (!type?.ext) return false

  return ['rar', 'zip', '7z', 'tar', 'tar.gz'].includes(type.ext)
}

/**
 * 统计目录中的文件数量（递归）
 */
async function countFiles(dir: string): Promise<number> {
  let count = 0
  for await (const _ of walk(dir, { includeDirs: false })) {
    count++
  }
  return count
}

/**
 * 使用 7z-wasm 执行解压
 * @param archivePath 压缩文件路径
 * @param destDir 目标目录
 */
async function extractWith7z(
  archivePath: string,
  destDir: string,
): Promise<void> {
  const sevenZip = await SevenZip()

  const absoluteArchivePath = await Deno.realPath(archivePath)
  const absoluteDestDir = await Deno.realPath(destDir)
  const archiveDir = dirname(absoluteArchivePath)
  const archiveName = basename(absoluteArchivePath)

  // 生成唯一的挂载点名称，避免并发冲突
  const mountId = ulid()
  const srcMount = `/src_${mountId}`
  const destMount = `/dest_${mountId}`

  try {
    // 创建挂载点目录 (在 VFS 中)
    sevenZip.FS.mkdir(srcMount)
    sevenZip.FS.mkdir(destMount)

    // 挂载源目录（包含压缩文件）和目标目录
    sevenZip.FS.mount(sevenZip.NODEFS, { root: archiveDir }, srcMount)
    sevenZip.FS.mount(sevenZip.NODEFS, { root: absoluteDestDir }, destMount)

    // 切换到目标目录
    sevenZip.FS.chdir(destMount)

    // 执行解压命令
    const archiveInVfs = posixJoin(srcMount, archiveName)
    const result = sevenZip.callMain(['x', '-y', archiveInVfs])

    if (result !== 0) {
      throw new Error(`7z 解压失败，返回码: ${result}`)
    }
  } finally {
    // 清理工作 (必须执行)
    try {
      sevenZip.FS.chdir('/')
      sevenZip.FS.unmount(srcMount)
      sevenZip.FS.unmount(destMount)
      sevenZip.FS.rmdir(srcMount)
      sevenZip.FS.rmdir(destMount)
    } catch {
      // 忽略清理阶段的错误
    }
  }
}

/**
 * 使用 7z-wasm 在 VFS 内完成 tar.gz 的两步解压
 * gzip -> tar (在 VFS 内存中) -> files (写入物理文件系统)
 * @param tarGzPath tar.gz 文件路径
 * @param destDir 目标目录
 */
async function extractTarGzInVfs(
  tarGzPath: string,
  destDir: string,
): Promise<void> {
  // @ts-ignore: npm package type definition issue
  const sevenZip = await SevenZip()

  const absoluteArchivePath = await Deno.realPath(tarGzPath)
  const absoluteDestDir = await Deno.realPath(destDir)
  const archiveDir = dirname(absoluteArchivePath)
  const archiveName = basename(absoluteArchivePath)

  // 生成唯一的挂载点和临时目录名称
  const mountId = ulid()
  const srcMount = `/src_${mountId}`
  const destMount = `/dest_${mountId}`
  const tmpDir = `/tmp_${mountId}` // VFS 内存中的临时目录

  try {
    // 创建挂载点和临时目录
    sevenZip.FS.mkdir(srcMount)
    sevenZip.FS.mkdir(destMount)
    sevenZip.FS.mkdir(tmpDir) // 这是 MEMFS，不会写入物理磁盘

    // 挂载源目录和目标目录
    sevenZip.FS.mount(sevenZip.NODEFS, { root: archiveDir }, srcMount)
    sevenZip.FS.mount(sevenZip.NODEFS, { root: absoluteDestDir }, destMount)

    // ========== 第一步：解压 gzip -> tar (到 VFS 内存临时目录) ==========
    sevenZip.FS.chdir(tmpDir)
    const archiveInVfs = posixJoin(srcMount, archiveName)
    const result1 = sevenZip.callMain(['x', '-y', archiveInVfs])

    if (result1 !== 0) {
      throw new Error(`tar.gz 第一步解压失败 (gzip)，返回码: ${result1}`)
    }

    // 在 VFS 临时目录中查找生成的 tar 文件
    const tmpDirContents = sevenZip.FS.readdir(tmpDir)
    let tarFileName: string | null = null
    for (const name of tmpDirContents) {
      if (name !== '.' && name !== '..') {
        tarFileName = name
        break
      }
    }

    if (!tarFileName) {
      throw new Error('tar.gz 解压后未找到 tar 文件')
    }

    // ========== 第二步：解压 tar -> files (到物理目标目录) ==========
    sevenZip.FS.chdir(destMount)
    const tarInVfs = posixJoin(tmpDir, tarFileName)
    const result2 = sevenZip.callMain(['x', '-y', tarInVfs])

    if (result2 !== 0) {
      throw new Error(`tar.gz 第二步解压失败 (tar)，返回码: ${result2}`)
    }
  } finally {
    // 清理工作
    try {
      sevenZip.FS.chdir('/')

      // 清理 VFS 临时目录中的文件
      try {
        const tmpContents = sevenZip.FS.readdir(tmpDir)
        for (const name of tmpContents) {
          if (name !== '.' && name !== '..') {
            sevenZip.FS.unlink(posixJoin(tmpDir, name))
          }
        }
      } catch {
        // 忽略清理错误
      }

      // 卸载和删除目录
      sevenZip.FS.unmount(srcMount)
      sevenZip.FS.unmount(destMount)
      sevenZip.FS.rmdir(srcMount)
      sevenZip.FS.rmdir(destMount)
      sevenZip.FS.rmdir(tmpDir)
    } catch {
      // 忽略清理阶段的错误
    }
  }
}

// ============================================================================
// 公开的解压函数
// ============================================================================

/**
 * 解压 RAR 文件到指定目录
 */
export async function extractRar(
  rarPath: string,
  destDir: string,
): Promise<void> {
  consola.start(`📦 解压 RAR 文件: ${basename(rarPath)}`)

  await ensureDir(destDir)
  await extractWith7z(rarPath, destDir)

  const count = await countFiles(destDir)
  consola.success(`解压完成，共 ${count} 个文件`)
}

/**
 * 解压 ZIP 文件到指定目录
 */
export async function extractZip(
  zipPath: string,
  destDir: string,
): Promise<void> {
  consola.start(`📦 解压 ZIP 文件: ${basename(zipPath)}`)

  await ensureDir(destDir)
  await extractWith7z(zipPath, destDir)

  const count = await countFiles(destDir)
  consola.success(`解压完成，共 ${count} 个文件`)
}

/**
 * 解压 7z 文件到指定目录
 */
export async function extract7z(
  sevenZipPath: string,
  destDir: string,
): Promise<void> {
  consola.start(`📦 解压 7z 文件: ${basename(sevenZipPath)}`)

  await ensureDir(destDir)
  await extractWith7z(sevenZipPath, destDir)

  const count = await countFiles(destDir)
  consola.success(`解压完成，共 ${count} 个文件`)
}

/**
 * 解压 tar 文件到指定目录（支持 .tar, .tar.gz）
 * 对于 tar.gz 文件，自动执行两步解压：gzip -> tar -> files
 */
export async function extractTar(
  tarPath: string,
  destDir: string,
): Promise<void> {
  consola.start(`📦 解压 TAR 文件: ${basename(tarPath)}`)

  await ensureDir(destDir)

  // 检测文件类型
  const fileType = await detectFileType(tarPath)
  const isTarGz = fileType?.ext === 'tar.gz'

  if (isTarGz) {
    // 使用 VFS 内存完成两步解压，不影响物理文件系统
    consola.info(`   🔄 检测到 tar.gz，在 VFS 内完成两步解压...`)
    await extractTarGzInVfs(tarPath, destDir)
  } else {
    // 单步解压纯 tar 文件
    await extractWith7z(tarPath, destDir)
  }

  const count = await countFiles(destDir)
  consola.success(`解压完成，共 ${count} 个文件`)
}

/**
 * 解压压缩文件到指定目录（统一入口）
 * 支持：zip, rar, 7z, tar, tar.gz
 */
export async function extractArchive(
  archivePath: string,
  destDir: string,
): Promise<void> {
  const fileType = await detectFileType(archivePath)

  if (!fileType?.ext) {
    throw new Error(`无法检测文件类型: ${archivePath}`)
  }

  switch (fileType.ext) {
    case 'rar':
      await extractRar(archivePath, destDir)
      break
    case 'zip':
      await extractZip(archivePath, destDir)
      break
    case '7z':
      await extract7z(archivePath, destDir)
      break
    case 'tar':
    case 'tar.gz':
      await extractTar(archivePath, destDir)
      break
    default:
      throw new Error(
        `不支持的压缩格式: ${fileType.ext} (${fileType.mime || 'unknown'})`,
      )
  }
}
