import { $ } from 'npm:zx@8.8.5'
import type { ProcessOutput } from 'npm:zx@8.8.5'

/**
 * assfonts CLI 执行结果
 */
export interface AssfontsCLIResult {
  ok: ProcessOutput['ok']
  cause: ProcessOutput['cause']
  message: ProcessOutput['message']
  stdout: ProcessOutput['stdout']
  stderr: ProcessOutput['stderr']
  command: string
}

/**
 * 执行 assfonts CLI 命令
 * @param binPath assfonts 二进制文件路径
 * @param inputFile 输入 ASS 文件路径
 * @param outputPath 输出目录路径
 * @param fontPaths 字体搜索路径列表
 * @returns CLI 执行结果
 */
export async function runAssfontsCli(
  binPath: string,
  inputFile: string,
  outputPath: string,
  fontPaths: string[],
): Promise<AssfontsCLIResult> {
  // 构建命令参数
  const args: string[] = ['-i', inputFile]
  args.push('-o', outputPath)

  for (const fontPath of fontPaths) {
    args.push('-f', fontPath)
  }

  // 固定 verbose 为 2
  args.push('-v', '2')

  const processPromise = $({ nothrow: true })`${binPath} ${args}`.quiet()
  const command = processPromise.cmd
  const result = await processPromise

  return {
    ok: result.ok,
    cause: result.cause,
    message: result.message,
    stdout: result.stdout,
    stderr: result.stderr,
    command,
  }
}
