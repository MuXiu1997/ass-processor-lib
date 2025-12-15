/** 将多行内容写入文件 */
export async function writeLines(path: string, lines: string[]): Promise<void> {
  await Deno.writeTextFile(path, lines.join('\n'))
}

/** 将多行内容追加到文件 */
export async function appendLines(
  path: string,
  lines: string[],
): Promise<void> {
  await Deno.writeTextFile(path, lines.join('\n'), { append: true })
}
