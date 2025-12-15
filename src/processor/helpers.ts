import { defu } from 'npm:defu@6.1.4'

/**
 * 生成一个从 start 到 end 的数字数组
 * @param startInclusive 开始数字
 * @param endInclusive 结束数字
 * @returns 数字数组
 */
export function range(startInclusive: number, endInclusive: number): number[] {
  return Array.from(
    { length: endInclusive - startInclusive + 1 },
    (_, i) => startInclusive + i,
  )
}

/**
 * 方括号 glob 模式的选项
 */
export interface GlobBracketOptions {
  /** 方括号前的前缀，默认为 '*' */
  prefix?: string
  /** 文件扩展名，默认为 '.ass' */
  extension?: string
  /** 索引数字的填充位数，默认为 2 */
  padding?: number
}

const defaultGlobBracketOptions: Required<GlobBracketOptions> = {
  prefix: '*',
  extension: '.ass',
  padding: 2,
}

/**
 * 生成方括号包围索引号的 glob 匹配模式
 *
 * @param index 索引号
 * @param options 配置选项
 * @returns glob 匹配模式字符串
 *
 * @example
 * // 返回 '*\\[01\\]*.ass'
 * globBracket(1)
 *
 * @example
 * // 返回 'sc/*\\[005\\]*.sc.ass'
 * globBracket(5, { prefix: 'sc/*', extension: '.sc.ass', padding: 3 })
 */
export function globBracket(
  index: number,
  options: GlobBracketOptions = {},
): string {
  const { prefix, extension, padding } = defu(
    options,
    defaultGlobBracketOptions,
  )
  const paddedIndex = index.toString().padStart(padding, '0')
  return `${prefix}\\[${paddedIndex}\\]*${extension}`
}
