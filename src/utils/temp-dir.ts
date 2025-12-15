/**
 * 创建临时目录并执行回调函数，完成后自动清理
 * @param prefix 临时目录前缀
 * @param callback 接收临时目录路径的回调函数
 * @returns 回调函数的返回值
 */
export async function withTempDir<T>(
  prefix: string,
  callback: (tempDir: string) => Promise<T>,
): Promise<T> {
  const tempDir = await Deno.makeTempDir({ prefix })

  try {
    return await callback(tempDir)
  } finally {
    try {
      await Deno.remove(tempDir, { recursive: true })
    } catch {
      // 忽略清理错误
    }
  }
}
