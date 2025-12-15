/**
 * assfonts 安装器模块
 *
 * 提供 assfonts 二进制文件的下载、安装和管理功能
 * 支持 macOS (Intel/Apple Silicon) 和 Linux (x86_64/ARM64)
 */

import { copy, ensureDir, exists, expandGlob } from 'jsr:@std/fs@1.0.20'
import { join } from 'jsr:@std/path@1.1.3'
import { $ } from 'npm:zx@8.8.5'
import { consola } from 'npm:consola@3.4.2'

import { withMountedDmg } from '../utils/dmg.ts'
import { download } from '../utils/download.ts'
import { extractArchive } from '../utils/extractors.ts'
import { withTempDir } from '../utils/temp-dir.ts'

const OS = Deno.build.os
const ARCH = Deno.build.arch
const HOME = Deno.env.get('HOME') || (() => {
  consola.error('HOME 环境变量未设置')
  Deno.exit(1)
})()
const XDG_DATA_HOME = Deno.env.get('XDG_DATA_HOME') ||
  join(HOME, '.local', 'share')

const ASSFONTS_VERSION = 'v0.7.3'
const ASSFONTS_INSTALL_DIR = join(XDG_DATA_HOME, `assfonts@${ASSFONTS_VERSION}`)
const ASSFONTS_BIN_DIR = join(ASSFONTS_INSTALL_DIR, 'bin')
const ASSFONTS_BIN_PATH = join(ASSFONTS_BIN_DIR, 'assfonts')

/**
 * 在指定目录中查找 assfonts 二进制文件
 * @param searchDir 搜索目录
 * @returns 找到的二进制文件路径，未找到则返回 null
 */
async function findAssfontsBinary(searchDir: string): Promise<string | null> {
  consola.start('搜索 assfonts 二进制文件...')

  for await (
    const entry of expandGlob('**/assfonts', {
      root: searchDir,
      includeDirs: false,
    })
  ) {
    if (entry.isFile) {
      consola.info(`找到二进制文件: ${entry.path}`)
      return entry.path
    }
  }

  return null
}

/**
 * 复制 assfonts 二进制文件到安装目录并设置可执行权限
 * @param sourcePath 源文件路径
 */
async function copyBinaryToInstallDir(sourcePath: string): Promise<void> {
  await copy(sourcePath, ASSFONTS_BIN_PATH)
  await Deno.chmod(ASSFONTS_BIN_PATH, 0o755)
  consola.info(`已安装到: ${ASSFONTS_BIN_PATH}`)
}

/**
 * 下载 assfonts 二进制文件到本地
 * 支持 Mac (Intel/Apple Silicon) 和 Linux (x86_64/ARM64) 系统
 */
async function downloadAssfonts(): Promise<void> {
  const baseUrl =
    `https://github.com/wyzdwdz/assfonts/releases/download/${ASSFONTS_VERSION}`

  const [assetName, isTarGz] = (() => {
    if (OS === 'darwin') {
      // macOS
      if (ARCH === 'x86_64' || ARCH === 'aarch64') {
        return [`assfonts-${ASSFONTS_VERSION}-${ARCH}-macOS.dmg`, false]
      }
      throw new Error(`不支持的 Mac 架构: ${ARCH}`)
    }
    if (OS === 'linux') {
      // Linux
      if (ARCH === 'x86_64' || ARCH === 'aarch64') {
        return [`assfonts-${ASSFONTS_VERSION}-${ARCH}-Linux.tar.gz`, true]
      }
      throw new Error(`不支持的 Linux 架构: ${ARCH}`)
    }
    throw new Error(`不支持的操作系统: ${OS}`)
  })()

  const downloadUrl = `${baseUrl}/${assetName}`

  consola.info(`检测到系统: ${OS} ${ARCH}`)
  consola.info(`下载文件: ${assetName}`)
  consola.info(`安装目录: ${ASSFONTS_INSTALL_DIR}`)

  // 确保 bin 目录存在
  await ensureDir(ASSFONTS_BIN_DIR)

  // 在临时目录中下载、解压并安装
  await withTempDir('assfonts-', async (tempDir) => {
    consola.info(`临时目录: ${tempDir}`)

    // 下载文件到临时目录
    const tempFile = join(tempDir, assetName)
    consola.start(`正在下载 ${downloadUrl}...`)
    await download(downloadUrl, tempFile)
    consola.success('下载完成，开始处理文件...')

    if (isTarGz) {
      // 处理 tar.gz 文件：解压到临时目录
      consola.start('解压 tar.gz 文件...')
      try {
        await extractArchive(tempFile, tempDir)
      } catch (error) {
        throw new Error('解压失败', { cause: error })
      }

      // 查找并安装 assfonts 二进制文件
      const foundBinPath = await findAssfontsBinary(tempDir)
      if (!foundBinPath) {
        throw new Error('未找到解压后的 assfonts 二进制文件')
      }
      await copyBinaryToInstallDir(foundBinPath)
    } else {
      // 处理 .dmg 文件：从挂载点查找并安装
      consola.start('处理 .dmg 文件...')
      await withMountedDmg(tempFile, async (mountPoint) => {
        const foundBinPath = await findAssfontsBinary(mountPoint)
        if (!foundBinPath) {
          throw new Error('在 dmg 中未找到 assfonts 二进制文件')
        }
        await copyBinaryToInstallDir(foundBinPath)
      })
    }
  })

  // 验证安装
  if (await exists(ASSFONTS_BIN_PATH, { isFile: true })) {
    consola.success(`assfonts ${ASSFONTS_VERSION} 安装成功!`)
    consola.info(`📍 位置: ${ASSFONTS_BIN_PATH}`)

    // 检查是否可执行
    try {
      const result = await $`${ASSFONTS_BIN_PATH} --help`
      if (result.stdout.includes('assfonts')) {
        consola.success(`assfonts 工作正常`)
      }
    } catch (e) {
      consola.warn('无法验证 assfonts:', e)
    }
  } else {
    throw new Error('安装失败：未找到二进制文件')
  }
}

/**
 * 确保 assfonts 已安装，如果未安装则自动安装
 */
export async function ensureAssfontsInstalled(): Promise<string> {
  // 检查二进制文件是否存在
  if (!(await exists(ASSFONTS_BIN_PATH, { isFile: true }))) {
    consola.info('assfonts 未安装，开始安装...')
    await downloadAssfonts()
    return ASSFONTS_BIN_PATH
  }

  // 检查二进制文件是否可执行
  try {
    const result = await $`${ASSFONTS_BIN_PATH} --help`
    if (result.stdout.includes(`assfonts ${ASSFONTS_VERSION}`)) {
      consola.success(`assfonts ${ASSFONTS_VERSION} 已安装`)
      return ASSFONTS_BIN_PATH
    }
  } catch {
    consola.warn('检测到 assfonts 文件存在但可能损坏，重新安装...')
  }

  // 如果检测失败，重新安装
  consola.start('重新安装 assfonts...')
  await downloadAssfonts()
  return ASSFONTS_BIN_PATH
}
