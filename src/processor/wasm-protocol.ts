import type {
  MissingGlyphPolicy,
  ParseMode,
  ProcessResult,
} from 'npm:@muxiu1997/assfonts-rs-wasm@0.1.0-beta.0'

export type {
  MissingGlyphPolicy,
  ParseMode,
  Report,
} from 'npm:@muxiu1997/assfonts-rs-wasm@0.1.0-beta.0'

export type WasmRequest =
  | {
    id: number
    type: 'process'
    fontPaths: string[]
    subtitle: Uint8Array
    parseMode: ParseMode
    missingGlyphPolicy: MissingGlyphPolicy
  }
  | { id: number; type: 'close' }

export type WasmResponse =
  | { id: number; ok: true; result?: ProcessResult }
  | { id: number; ok: false; code: string; message: string }
