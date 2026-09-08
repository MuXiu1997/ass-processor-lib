/// <reference lib="deno.worker" />

import {
  AssfontsError,
  createEngine,
  type Engine,
} from 'npm:@muxiu1997/assfonts-rs-wasm@0.1.0-beta.0'
import type { WasmRequest, WasmResponse } from './wasm-protocol.ts'

let engine: Engine | undefined
let fontKey: string | undefined
let queue = Promise.resolve()

async function handle(request: WasmRequest): Promise<void> {
  let response: WasmResponse
  try {
    if (request.type === 'close') {
      engine?.close()
      engine = undefined
      fontKey = undefined
      response = { id: request.id, ok: true }
    } else {
      const key = JSON.stringify(request.fontPaths)
      if (!engine || key !== fontKey) {
        engine?.close()
        engine = undefined
        fontKey = undefined
        const next = await createEngine()
        try {
          for (const path of request.fontPaths) {
            next.addFont(path, await Deno.readFile(path))
          }
        } catch (error) {
          next.close()
          throw error
        }
        engine = next
        fontKey = key
      }
      engine.setParseMode(request.parseMode)
      engine.setMissingGlyphPolicy(request.missingGlyphPolicy)
      response = {
        id: request.id,
        ok: true,
        result: engine.process(request.subtitle),
      }
    }
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      code: error instanceof AssfontsError ? error.code : 'IO',
      message: error instanceof Error ? error.message : String(error),
    }
  }
  postMessage(response)
}

onmessage = (event: MessageEvent<WasmRequest>) => {
  queue = queue.then(() => handle(event.data))
}
