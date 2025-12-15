import { $ } from 'npm:zx@8.8.5'
import { consola } from 'npm:consola@3.4.2'
import { withTempDir } from './temp-dir.ts'

/**
 * 挂载 DMG 文件并执行回调函数，完成后自动卸载并清理临时目录
 * @param dmgPath DMG 文件路径
 * @param callback 接收挂载点路径的回调函数
 * @returns 回调函数的返回值
 */
export async function withMountedDmg<T>(
  dmgPath: string,
  callback: (mountPoint: string) => Promise<T>,
): Promise<T> {
  return await withTempDir('dmg_mount_', async (mountPoint) => {
    // 挂载 dmg
    try {
      await $`hdiutil attach ${dmgPath} -mountpoint ${mountPoint} -nobrowse`
    } catch (error) {
      throw new Error(`挂载 dmg 失败`, { cause: error })
    }

    try {
      return await callback(mountPoint)
    } finally {
      // 确保卸载 dmg
      try {
        await $`hdiutil detach ${mountPoint}`
      } catch (e) {
        consola.warn('卸载 dmg 时出错:', e)
      }
    }
  })
}
