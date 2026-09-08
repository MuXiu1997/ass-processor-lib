import { ensureDir } from 'jsr:@std/fs@1.0.20'
import { basename, extname, join } from 'jsr:@std/path@1.1.3'

import { consola } from 'npm:consola@3.4.2'
import dayjs from 'npm:dayjs@1.11.19'
import { defu } from 'npm:defu@6.1.4'

import { appendLines, writeLines } from '../utils/file.ts'
import { getUniqueFileByGlob } from '../utils/glob.ts'
import { TempDirCache } from './temp-dir-cache.ts'
import { type SubtitleTransform, withPreparedSubtitle } from './subtitle.ts'
import { scanFonts, WasmBackend } from './wasm-backend.ts'
import type { MissingGlyphPolicy, ParseMode, Report } from './wasm-protocol.ts'

// ============================================================================
// 常量
// ============================================================================

const SEPARATOR = '='.repeat(60)
const DASH_LINE = '-'.repeat(60)

const FONT_EXTENSIONS = ['.ttf', '.otf', '.ttc', '.otc', '.woff', '.woff2']
const SUBTITLE_EXTENSIONS = ['.ass', '.ssa', '.srt']

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 单个处理配置
 * 每个 glob 必须精确匹配一个文件
 */
export interface ProcessConfig {
  /** 字体目录或压缩文件（支持单个或多个） */
  fontDir: string | string[]
  /** 原始字幕目录或压缩文件 */
  subtitleDir: string
  /** 字幕文件 glob 模式，必须精确匹配一个文件 */
  subtitleGlob: string
  /** 输出目录（视频文件所在目录） */
  outputDir: string
  /** 视频文件 glob 模式，必须精确匹配一个文件 */
  videoGlob: string
  /** 输出后缀，例如 ".sc.ass" */
  outputSuffix: string
  /** 原始字幕文本编码；设置后严格解码并生成 UTF-8 工作副本 */
  subtitleEncoding?: string
  /** 字幕内容转换函数，在处理前对原始字幕内容进行修改 */
  subtitleTransform?: SubtitleTransform
  /** WASM 后端解析模式，默认 strict */
  parseMode?: ParseMode
  /** WASM 后端缺字策略，默认 warn */
  missingGlyphPolicy?: MissingGlyphPolicy
}

/**
 * 批处理结果
 */
export interface BatchResult {
  success: boolean
  inputFile: string
  outputFile: string
  error?: string
  /** WASM 后端的字体处理报告 */
  report?: Report
}

/**
 * 批处理选项
 */
export interface BatchProcessorOptions {
  /** WASM 单次请求超时，包含初始化和字体注册，默认 120 秒 */
  wasmTimeoutMs?: number
  /** 自定义日志文件路径，如果不提供则自动生成 */
  logFile?: string
  /** 是否禁用日志文件 */
  disableLog?: boolean
}

// ============================================================================
// 工具函数
// ============================================================================

/** 从 unknown 类型的 error 中提取错误信息 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 生成批处理日志文件路径 */
function generateBatchLogPath(): string {
  const timestamp = dayjs().format('YYYY-MM-DD_HH-mm-ss')
  return join(Deno.cwd(), `assfonts-batch-${timestamp}.log`)
}

// ============================================================================
// BatchProcessor 类
// ============================================================================

/**
 * ASS 字幕批处理器
 *
 * 用于批量处理 ASS 字幕文件，进行字体子集化和内嵌。
 * 自动管理临时目录缓存，支持压缩文件解压复用。
 * 处理完成后自动清理临时资源。
 *
 * @example
 * ```ts
 * const processor = new BatchProcessor()
 *
 * // 处理单个任务
 * const result = await processor.process(config)
 *
 * // 或处理多个任务
 * const { results, logFile } = await processor.process([config1, config2])
 * ```
 */
const defaultOptions: Required<BatchProcessorOptions> = {
  wasmTimeoutMs: 120_000,
  logFile: '',
  disableLog: false,
}

export class BatchProcessor {
  private wasm?: WasmBackend
  private processing = false
  private cache: TempDirCache
  private options: Required<BatchProcessorOptions>
  private logFile?: string
  private initialized = false

  constructor(options: BatchProcessorOptions = {}) {
    this.options = defu(options, defaultOptions)
    this.cache = new TempDirCache()
    this.logFile = this.options.logFile || undefined
  }

  /**
   * 准备目录（如果是压缩文件则解压，使用缓存）
   */
  private async prepareDirectory(
    path: string,
    description: string,
    options?: { allowedExtensions?: string[] },
  ): Promise<string> {
    try {
      return await this.cache.getOrPrepare(path, description, options)
    } catch (error) {
      throw new Error(`${description} "${path}" 准备失败`, { cause: error })
    }
  }

  /**
   * 处理单个配置项
   */
  private async processOne(
    wasm: WasmBackend,
    item: ProcessConfig,
    index?: number,
    total?: number,
  ): Promise<BatchResult> {
    const fontDirs = Array.isArray(item.fontDir) ? item.fontDir : [item.fontDir]
    let subtitleFile = ''
    let outputFile = ''
    let report: Report | undefined

    consola.log('\n' + DASH_LINE)
    if (index != null && total != null) {
      consola.info(`[${index + 1}/${total}] 处理中...`)
    }
    consola.info(`📁 字体源: ${fontDirs.join(', ')}`)
    consola.info(`📂 字幕源: ${item.subtitleDir}`)
    consola.info(`🔍 字幕 glob: ${item.subtitleGlob}`)
    consola.info(`📤 输出目录: ${item.outputDir}`)
    consola.info(`🎬 视频 glob: ${item.videoGlob}`)
    consola.info(`📝 输出后缀: ${item.outputSuffix}`)
    if (item.subtitleEncoding) {
      consola.info(`🔤 字幕编码: ${item.subtitleEncoding}`)
    }
    consola.log(DASH_LINE)

    try {
      const actualFontDirs: string[] = []
      for (const [idx, dir] of fontDirs.entries()) {
        actualFontDirs.push(
          await this.prepareDirectory(
            dir,
            fontDirs.length > 1 ? `字体${idx + 1}` : '字体',
            { allowedExtensions: FONT_EXTENSIONS },
          ),
        )
      }
      const actualSubtitleDir = await this.prepareDirectory(
        item.subtitleDir,
        '字幕',
        { allowedExtensions: SUBTITLE_EXTENSIONS },
      )

      subtitleFile = await getUniqueFileByGlob(
        actualSubtitleDir,
        item.subtitleGlob,
      )
      consola.info(`📥 字幕文件: ${basename(subtitleFile)}`)

      const videoFile = await getUniqueFileByGlob(
        item.outputDir,
        item.videoGlob,
      )
      consola.info(`🎬 视频文件: ${basename(videoFile)}`)

      const videoBasename = basename(videoFile)
      const outputFilename =
        videoBasename.slice(0, -extname(videoBasename).length) +
        item.outputSuffix
      outputFile = join(item.outputDir, outputFilename)
      consola.info(`📤 输出文件: ${outputFilename}`)

      await ensureDir(item.outputDir)

      if (item.subtitleTransform) {
        consola.info(`🔄 应用字幕内容转换...`)
      }

      await withPreparedSubtitle(
        subtitleFile,
        {
          encoding: item.subtitleEncoding,
          transform: item.subtitleTransform,
        },
        async (preparedSubtitleFile) => {
          const fonts = await scanFonts(actualFontDirs)
          const result = await wasm.process(
            fonts,
            await Deno.readFile(preparedSubtitleFile),
            item.parseMode,
            item.missingGlyphPolicy,
          )
          await Deno.writeTextFile(outputFile, result.subtitle)
          report = result.report
          for (const warning of report.warnings) {
            consola.warn(JSON.stringify(warning))
          }
          if (this.logFile) {
            await appendLines(this.logFile, [
              `WASM 处理文件: ${subtitleFile}`,
              JSON.stringify(report, null, 2),
            ])
          }
        },
      )

      consola.success(`处理完成: ${outputFilename}`)

      return {
        success: true,
        inputFile: subtitleFile,
        outputFile,
        ...(report ? { report } : {}),
      }
    } catch (error) {
      consola.error(`处理失败: ${getErrorMessage(error)}`)
      if (this.logFile) {
        await appendLines(this.logFile, [
          `处理失败: ${subtitleFile}: ${getErrorMessage(error)}`,
        ])
      }
      return {
        success: false,
        inputFile: subtitleFile,
        outputFile,
        error: getErrorMessage(error),
      }
    }
  }

  /**
   * 初始化日志文件
   */
  private async initLogFile(itemCount: number): Promise<void> {
    if (this.initialized || this.options.disableLog) return

    this.logFile = this.logFile || generateBatchLogPath()
    await writeLines(this.logFile, [
      `assfonts 批处理日志`,
      `开始时间: ${dayjs().format('YYYY-MM-DD HH:mm:ss')}`,
      `任务数量: ${itemCount}`,
      SEPARATOR,
      '',
    ])
    consola.info(`📝 日志文件: ${this.logFile}`)

    this.initialized = true
  }

  /**
   * 写入日志摘要
   */
  private async writeLogSummary(
    successCount: number,
    failCount: number,
    total: number,
  ): Promise<void> {
    if (!this.logFile) return

    await appendLines(this.logFile, [
      '',
      SEPARATOR,
      `批处理完成`,
      `结束时间: ${dayjs().format('YYYY-MM-DD HH:mm:ss')}`,
      `成功: ${successCount}`,
      `失败: ${failCount}`,
      `未执行: ${total - successCount - failCount}`,
      SEPARATOR,
    ])
  }

  /**
   * 处理配置（支持单个或多个）
   * 处理完成后自动清理临时资源
   *
   * @param configs 单个配置或配置数组
   * @returns 批处理结果和日志文件路径
   */
  async process(
    configs: ProcessConfig | ProcessConfig[],
  ): Promise<{ results: BatchResult[]; logFile?: string }> {
    if (this.processing) throw new Error('同一 BatchProcessor 不支持并发批次')
    this.processing = true
    const items = Array.isArray(configs) ? configs : [configs]

    consola.log('\n' + SEPARATOR)
    consola.start('📦 开始批处理')
    consola.info(`📋 共 ${items.length} 个任务`)
    consola.log(SEPARATOR)

    const results: BatchResult[] = []
    let successCount = 0
    let failCount = 0

    try {
      const wasm = new WasmBackend(this.options.wasmTimeoutMs)
      this.wasm = wasm
      await this.initLogFile(items.length)
      for (let i = 0; i < items.length; i++) {
        const result = await this.processOne(wasm, items[i], i, items.length)
        results.push(result)

        if (result.success) {
          successCount++
        } else {
          failCount++
          consola.error(`批处理在第 ${i + 1} 项失败，停止执行`)
          break
        }
      }

      await this.writeLogSummary(successCount, failCount, items.length)

      consola.log('\n' + SEPARATOR)
      consola.success('📊 批处理完成')
      consola.log(SEPARATOR)
      consola.info(`  ✅ 成功: ${successCount}`)
      consola.info(`  ❌ 失败: ${failCount}`)
      consola.info(`  ⏸️  未执行: ${items.length - successCount - failCount}`)
      if (this.logFile) {
        consola.info(`  📝 日志: ${this.logFile}`)
      }
      consola.log(SEPARATOR + '\n')

      if (failCount > 0) {
        throw new Error(`批处理失败: ${failCount} 个任务失败`)
      }

      return { results, logFile: this.logFile }
    } finally {
      try {
        await this.cleanup()
      } finally {
        this.processing = false
      }
    }
  }

  /**
   * 清理所有临时资源
   * 应在所有处理完成后调用
   */
  async cleanup(): Promise<void> {
    try {
      await this.wasm?.close()
    } finally {
      this.wasm = undefined
      await this.cache.cleanup()
    }
  }
}

export function process(
  configs: ProcessConfig | ProcessConfig[],
  options: BatchProcessorOptions = {},
): Promise<{ results: BatchResult[]; logFile?: string }> {
  const processor = new BatchProcessor(options)
  return processor.process(configs)
}

// 导出辅助函数
export { globBracket, range } from './helpers.ts'
export type { MissingGlyphPolicy, ParseMode, Report } from './wasm-protocol.ts'
