import { isAbsolute, parse, relative, sep } from 'npm:pathe@2.0.3'
import _SevenZip, { type SevenZipModuleFactory } from 'npm:7z-wasm@1.2.0'
import readlineSync from 'npm:readline-sync@1.4.10'

const SevenZip = _SevenZip as unknown as SevenZipModuleFactory

async function main(): Promise<void> {
  let buf: string | undefined
  let i = 0
  const stdoutBuf = new Uint8Array(16 * 1024)
  let stdoutLen = 0

  const flushStdout = (): void => {
    if (stdoutLen > 0) {
      Deno.stdout.writeSync(stdoutBuf.subarray(0, stdoutLen))
      stdoutLen = 0
    }
  }

  try {
    const sevenZip = await SevenZip({
      stdin: (): number => {
        if (!buf) {
          buf = readlineSync.question() + '\n'
        }
        if (i < buf.length) {
          return buf.charCodeAt(i++)
        }
        buf = undefined
        i = 0
        return 0
      },
      stdout: (byte: number): void => {
        // 7z-wasm passes raw bytes here, don't convert to JS string then re-encode as UTF-8, or it will corrupt the original bytes and cause garbled output
        stdoutBuf[stdoutLen++] = byte & 0xff
        // flush output by line/chunk to avoid frequent system calls
        if (stdoutLen >= stdoutBuf.length || byte === 0x0a /* \n */) {
          flushStdout()
        }
      },
      quit: (code: number): void => {
        flushStdout()
        if (code) {
          Deno.exit(code)
        }
      },
    })

    // HACK: The WASM 7-Zip sets file mode to 000 when extracting tar archives, making it impossible to extract sub-folders
    const chmodOrig = sevenZip.FS.chmod
    sevenZip.FS.chmod = function (
      path: string,
      mode: number,
      dontFollow?: boolean,
    ): void {
      if (!mode) {
        return
      }
      chmodOrig(path, mode, dontFollow)
    }

    const cwd = Deno.cwd()
    const hostRoot = parse(cwd).root
    const hostDir = relative(hostRoot, cwd).split(sep).join('/')
    const mountRoot = '/nodefs'
    sevenZip.FS.mkdir(mountRoot)
    sevenZip.FS.mount(sevenZip.NODEFS, { root: hostRoot }, mountRoot)
    sevenZip.FS.chdir(mountRoot + '/' + hostDir)

    const args = Deno.args.map((arg) => {
      if (isAbsolute(arg)) {
        const relPath = relative(hostRoot, arg).split(sep).join('/')
        return mountRoot + '/' + relPath
      }
      return arg
    })
    await sevenZip.callMain(args)
    flushStdout()
  } catch (e) {
    flushStdout()
    console.error(e)
    Deno.exit(-1)
  }
}

await main()
