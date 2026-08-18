import { describe, expect, it } from 'vitest'

import { languageFor } from './lang'

describe('languageFor', () => {
  it.each([
    ['a.ts', 'typescript'],
    ['a.tsx', 'tsx'],
    ['a.js', 'javascript'],
    ['a.mjs', 'javascript'],
    ['a.jsx', 'jsx'],
    ['a.go', 'go'],
    ['a.py', 'python'],
    ['a.rs', 'rust'],
    ['a.md', 'markdown'],
    ['a.json', 'json'],
    ['a.jsonc', 'jsonc'],
    ['a.css', 'css'],
    ['a.sh', 'shellscript'],
    ['a.bash', 'shellscript'],
    ['a.zsh', 'shellscript'],
    ['a.yml', 'yaml'],
    ['a.yaml', 'yaml'],
    ['a.sql', 'sql'],
    ['a.rb', 'ruby'],
    ['a.c', 'c'],
    ['a.h', 'c'],
    ['a.cpp', 'cpp'],
    ['a.hpp', 'cpp'],
    ['a.java', 'java'],
    ['a.kt', 'kotlin'],
    ['a.swift', 'swift'],
    ['a.html', 'html'],
    ['a.toml', 'toml'],
    ['a.diff', 'diff'],
    ['a.patch', 'diff'],
    ['a.xml', 'xml'],
    ['a.ini', 'ini'],
    ['a.php', 'php'],
    ['a.proto', 'proto'],
    ['a.scss', 'scss'],
    ['a.vue', 'vue'],
    ['a.svelte', 'svelte'],
    ['a.lua', 'lua'],
    ['a.zig', 'zig'],
    ['a.graphql', 'graphql'],
  ])('%s -> %s', (name, want) => {
    expect(languageFor(name)).toBe(want)
  })

  it.each([
    ['Dockerfile', 'docker'],
    ['Makefile', 'make'],
    ['makefile', 'make'],
  ])('special name %s -> %s', (name, want) => {
    expect(languageFor(name)).toBe(want)
  })

  it('matches on the basename of a full path', () => {
    expect(languageFor('/home/k/proj/Makefile')).toBe('make')
    expect(languageFor('/home/k/proj/wire.go')).toBe('go')
  })

  it('is case-insensitive about the extension', () => {
    expect(languageFor('README.MD')).toBe('markdown')
  })

  it.each([['a.weird'], ['noext'], ['go.mod'], ['.bashrc']])('%s -> null', (name) => {
    expect(languageFor(name)).toBeNull()
  })
})
