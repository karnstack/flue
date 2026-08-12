import { describe, expect, it } from 'vitest'

import { newSessionSearch, validateNewSessionSearch } from './new-session'

describe('newSessionSearch', () => {
  it('carries everything that was actually asked for', () => {
    expect(
      newSessionSearch({
        machineId: 'attic-pi',
        cwd: '/Users/karn/code/flue',
        name: 'deploy',
        tags: ['ops', 'api'],
      }),
    ).toEqual({
      d: 'attic-pi',
      cwd: '/Users/karn/code/flue',
      name: 'deploy',
      tags: ['ops', 'api'],
    })
  })

  it('omits an empty answer rather than sending it blank', () => {
    // The same rule `flue open` follows for an empty cwd. A parameter that is
    // sometimes '' and sometimes absent is one more case for the page to tell
    // apart, and both already mean "nothing was asked for".
    expect(newSessionSearch({ machineId: '', cwd: '   ', name: '  ', tags: [] })).toEqual({})
    expect(newSessionSearch({})).toEqual({})
  })

  it('trims what the reader typed, and drops a tag that was only spaces', () => {
    expect(newSessionSearch({ cwd: '  /tmp  ', name: '  build  ', tags: ['  api  ', '   '] }))
      .toEqual({ cwd: '/tmp', name: 'build', tags: ['api'] })
  })

  it('keeps tags a list, so a tag with a comma in it stays one tag', () => {
    // The reason this is an array and not a joined string: the daemon takes
    // free text, and joining would quietly turn one tag into two.
    expect(newSessionSearch({ tags: ['a,b'] }).tags).toEqual(['a,b'])
  })
})

describe('validateNewSessionSearch', () => {
  it('takes the four fields it knows, whole', () => {
    expect(
      validateNewSessionSearch({ d: 'local', cwd: '/tmp', name: 'x', tags: ['api'] }),
    ).toEqual({ d: 'local', cwd: '/tmp', name: 'x', tags: ['api'] })
  })

  it('ignores anything that is not the shape the page can act on', () => {
    // A link can be edited by hand and a parameter given twice parses to an
    // array, so none of this is hypothetical. What is dropped lands on the
    // page's own defaults: this machine, the daemon's directory, no metadata.
    expect(
      validateNewSessionSearch({
        d: ['local', 'attic-pi'],
        cwd: 7,
        name: null,
        tags: 'api',
        stray: 'ignored',
      }),
    ).toEqual({})
  })

  it('drops the blanks out of a tag list, and the list if nothing survives', () => {
    expect(validateNewSessionSearch({ tags: ['api', '', '  ', 3] })).toEqual({ tags: ['api'] })
    expect(validateNewSessionSearch({ tags: ['', '  '] })).toEqual({})
  })

  it('treats an empty string as absent, exactly as the builder does', () => {
    expect(validateNewSessionSearch({ d: '', cwd: '', name: '' })).toEqual({})
  })
})
