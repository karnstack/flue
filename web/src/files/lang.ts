/*
 * Which highlighter grammar a clicked file gets, from its name alone.
 *
 * The extension is a heuristic and that is fine: a wrong guess renders as
 * oddly coloured text, a missing one as plain text, and neither is worth a
 * second round trip to sniff content. Every id here must name a grammar the
 * shiki bundle ships, because it becomes a dynamic import of that chunk.
 */

const SPECIAL_NAMES: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'make',
}

const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  go: 'go',
  py: 'python',
  rs: 'rust',
  md: 'markdown',
  json: 'json',
  jsonc: 'jsonc',
  css: 'css',
  scss: 'scss',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  rb: 'ruby',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  html: 'html',
  toml: 'toml',
  diff: 'diff',
  patch: 'diff',
  xml: 'xml',
  ini: 'ini',
  php: 'php',
  proto: 'proto',
  vue: 'vue',
  svelte: 'svelte',
  lua: 'lua',
  zig: 'zig',
  graphql: 'graphql',
}

export function languageFor(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const special = SPECIAL_NAMES[base]
  if (special !== undefined) return special
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null
  return BY_EXTENSION[base.slice(dot + 1)] ?? null
}
