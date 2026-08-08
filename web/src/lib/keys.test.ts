import { describe, expect, it } from 'vitest'
import { barKeyBytes, ctrlTransform } from './keys'

const text = (b: Uint8Array) => new TextDecoder().decode(b)

describe('barKeyBytes', () => {
  it('encodes arrows as CSI when the program has not asked for more', () => {
    expect(text(barKeyBytes('up', { appCursor: false, ctrl: false }))).toBe('\x1b[A')
    expect(text(barKeyBytes('down', { appCursor: false, ctrl: false }))).toBe('\x1b[B')
    expect(text(barKeyBytes('right', { appCursor: false, ctrl: false }))).toBe('\x1b[C')
    expect(text(barKeyBytes('left', { appCursor: false, ctrl: false }))).toBe('\x1b[D')
  })

  it('switches arrows to SS3 under application cursor keys', () => {
    expect(text(barKeyBytes('up', { appCursor: true, ctrl: false }))).toBe('\x1bOA')
    expect(text(barKeyBytes('left', { appCursor: true, ctrl: false }))).toBe('\x1bOD')
  })

  it('encodes Ctrl-arrows as modified CSI, whatever the cursor mode', () => {
    // xterm sends CSI 1;5 for ctrl-arrows even in application mode.
    expect(text(barKeyBytes('up', { appCursor: false, ctrl: true }))).toBe('\x1b[1;5A')
    expect(text(barKeyBytes('right', { appCursor: true, ctrl: true }))).toBe('\x1b[1;5C')
  })

  it('sends esc and tab as their single bytes, ctrl or not', () => {
    expect(text(barKeyBytes('esc', { appCursor: false, ctrl: false }))).toBe('\x1b')
    expect(text(barKeyBytes('tab', { appCursor: true, ctrl: true }))).toBe('\x09')
  })
})

describe('ctrlTransform', () => {
  const of = (...b: number[]) => Uint8Array.from(b)

  it('folds letters onto control codes, either case', () => {
    expect(ctrlTransform(of(0x63))).toEqual(of(0x03)) // c → ETX (Ctrl+C)
    expect(ctrlTransform(of(0x43))).toEqual(of(0x03)) // C too
    expect(ctrlTransform(of(0x64))).toEqual(of(0x04)) // d → EOT
  })

  it('covers the punctuation controls a terminal actually uses', () => {
    expect(ctrlTransform(of(0x5b))).toEqual(of(0x1b)) // [ → ESC
    expect(ctrlTransform(of(0x20))).toEqual(of(0x00)) // space → NUL
    expect(ctrlTransform(of(0x3f))).toEqual(of(0x7f)) // ? → DEL
  })

  it('declines anything it cannot fold', () => {
    expect(ctrlTransform(of(0x31))).toBeNull() // digit
    expect(ctrlTransform(new TextEncoder().encode('é'))).toBeNull() // multi-byte
    expect(ctrlTransform(new TextEncoder().encode('ls'))).toBeNull() // paste
  })
})
