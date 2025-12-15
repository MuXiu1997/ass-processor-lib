import { basename, resolve } from 'jsr:@std/path@1.1.3'
import fg from 'npm:fast-glob@3.3.3'

/**
 * 使用 glob 模式获取文件列表
 *
 * 使用 fast-glob 进行匹配，通过 cwd 选项来避免目录路径中的特殊字符被解释为 glob 模式。
 * 支持转义特殊字符，例如 `\[01\]` 可以匹配字面的 `[01]`。
 *
 * @param dir - 搜索目录路径（会自动转换为绝对路径）
 * @param pattern - glob 匹配模式
 * @returns 匹配文件的绝对路径数组
 */
export async function getFilesByGlob(
  dir: string,
  pattern: string,
): Promise<string[]> {
  const absoluteDir = resolve(dir)
  const files = await fg(pattern, {
    onlyFiles: true,
    cwd: absoluteDir,
    absolute: true,
  })
  return files
}

/**
 * 使用 glob 模式获取唯一文件
 *
 * 要求 glob 模式必须精确匹配一个文件，否则抛出异常。
 *
 * @param dir - 搜索目录路径
 * @param glob - glob 匹配模式
 * @returns 匹配文件的绝对路径
 * @throws 当匹配到 0 个或多个文件时抛出错误
 */
export async function getUniqueFileByGlob(
  dir: string,
  glob: string,
): Promise<string> {
  const files = await getFilesByGlob(dir, glob)

  if (files.length === 0) {
    throw new Error(
      `glob "${glob}" 在目录 "${dir}" 中没有匹配到任何文件`,
    )
  }

  if (files.length > 1) {
    const fileList = files.map((f) => `  - ${basename(f)}`).join('\n')
    throw new Error(
      `glob "${glob}" 在目录 "${dir}" 中匹配到多个文件:\n${fileList}`,
    )
  }

  return files[0]
}
