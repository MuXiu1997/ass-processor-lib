import { walk } from 'jsr:@std/fs@1.0.20'
import { extname } from 'jsr:@std/path@1.1.3'
import type { ProcessResult } from 'npm:@muxiu1997/assfonts-rs-wasm@0.1.0-beta.0'
import type {
  MissingGlyphPolicy,
  ParseMode,
  WasmRequest,
  WasmResponse,
} from './wasm-protocol.ts'

export class WasmBackendError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'WasmBackendError'
  }
}

/** Preserve source-directory priority and sort files deterministically within each directory. */
export async function scanFonts(directories: string[]): Promise<string[]> {
  const paths: string[] = []
  for (const directory of directories) {
    const files: string[] = []
    for await (const entry of walk(directory, { includeDirs: false })) {
      const extension = extname(entry.path).toLowerCase()
      if (['.woff', '.woff2'].includes(extension)) {
        throw new WasmBackendError(
          'INPUT',
          `WASM 不支持字体格式: ${entry.path}`,
        )
      }
      if (['.ttf', '.otf', '.ttc', '.otc'].includes(extension)) {
        files.push(entry.path)
      }
    }
    paths.push(...files.sort())
  }
  return [...new Set(paths)]
}

/** A single, sequential Worker. Font files must remain unchanged until close(). */
export class WasmBackend {
  private worker?: Worker
  private nextId = 0
  private closed = false
  private pending?: {
    id: number
    resolve: (response: WasmResponse) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }

  constructor(private readonly timeoutMs = 120_000) {
    if (
      !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647
    ) {
      throw new RangeError('wasmTimeoutMs 必须为 1 到 2147483647 之间的毫秒数')
    }
  }

  private terminate(error: Error): void {
    this.closed = true
    this.worker?.terminate()
    this.worker = undefined
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending.reject(error)
      this.pending = undefined
    }
  }

  private request(request: WasmRequest): Promise<WasmResponse> {
    if (this.closed) {
      return Promise.reject(
        new WasmBackendError('CLOSED', 'WASM backend 已关闭'),
      )
    }
    if (this.pending) {
      return Promise.reject(
        new WasmBackendError('BUSY', 'WASM backend 必须串行调用'),
      )
    }
    if (!this.worker) {
      this.worker = new Worker(
        new URL('./wasm-worker.ts', import.meta.url).href,
        { type: 'module' },
      )
      this.worker.onmessage = (event: MessageEvent<WasmResponse>) => {
        const pending = this.pending
        if (!pending || event.data.id !== pending.id) return
        clearTimeout(pending.timer)
        this.pending = undefined
        if (
          !event.data.ok &&
          ['FATAL', 'INITIALIZATION'].includes(event.data.code)
        ) {
          this.terminate(
            new WasmBackendError(event.data.code, event.data.message),
          )
        }
        pending.resolve(event.data)
      }
      this.worker.onerror = (event) => {
        event.preventDefault()
        this.terminate(new WasmBackendError('FATAL', event.message))
      }
      this.worker.onmessageerror = () =>
        this.terminate(new WasmBackendError('FATAL', '无法读取 Worker 响应'))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.terminate(
            new WasmBackendError(
              'TIMEOUT',
              `WASM 请求超时 (${this.timeoutMs} ms)`,
            ),
          ),
        this.timeoutMs,
      )
      this.pending = { id: request.id, resolve, reject, timer }
      try {
        this.worker!.postMessage(request)
      } catch (error) {
        this.terminate(
          error instanceof Error ? error : new Error(String(error)),
        )
      }
    })
  }

  async process(
    fontPaths: string[],
    subtitle: Uint8Array,
    parseMode: ParseMode = 'strict',
    missingGlyphPolicy: MissingGlyphPolicy = 'warn',
  ): Promise<ProcessResult> {
    const response = await this.request({
      id: ++this.nextId,
      type: 'process',
      fontPaths,
      subtitle,
      parseMode,
      missingGlyphPolicy,
    })
    if (!response.ok) {
      throw new WasmBackendError(response.code, response.message)
    }
    if (!response.result) {
      const error = new WasmBackendError('FATAL', 'WASM 未返回处理结果')
      this.terminate(error)
      throw error
    }
    return response.result
  }

  async close(): Promise<void> {
    if (this.closed) return
    try {
      if (this.worker && !this.pending) {
        await this.request({ id: ++this.nextId, type: 'close' })
      }
    } finally {
      this.terminate(new WasmBackendError('CLOSED', 'WASM backend 已关闭'))
    }
  }
}
