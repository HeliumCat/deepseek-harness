/** Access-token lifecycle and URL construction. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensurePetToken, petUrls } from '../src/token.ts'

const roots: string[] = []

async function tokenFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pet-token-'))
  roots.push(directory)
  return join(directory, 'token')
}

afterEach(async () => {
  for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('pet token', () => {
  it('creates one token and reuses it', async () => {
    const path = await tokenFile()
    const first = await ensurePetToken(path)
    const second = await ensurePetToken(path)
    expect(first).toMatch(/^[0-9a-f]{64}$/u)
    expect(second).toBe(first)
  })

  it('rejects a malformed existing token', async () => {
    const path = await tokenFile()
    await writeFile(path, 'not-a-token\n')
    await expect(ensurePetToken(path)).rejects.toThrow(/does not hold a hex token/u)
  })

  it('builds token-carrying page and MCP URLs', () => {
    expect(petUrls('http://127.0.0.1:3080', '/pet', '/pet/mcp', 'abc')).toEqual({
      page: 'http://127.0.0.1:3080/pet?token=abc',
      mcp: 'http://127.0.0.1:3080/pet/mcp?token=abc',
    })
  })
})
