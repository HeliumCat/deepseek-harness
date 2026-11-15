/**
 * The pet access token: one user-private random secret persisted under the
 * Harness home so Codex's config and the pet page URL stay stable across worker
 * restarts. Every pet route and the MCP endpoint require it.
 *
 * @module @deepseek-ai/dsh-pet-app/token
 */

import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

const TOKEN_BYTES = 32

/** Whether a stored token is usable as a pet credential. */
function usable(value: string): boolean {
  return /^[0-9a-f]{32,}$/u.test(value)
}

/**
 * Read the token, creating it on first use.
 * @param path - absolute token file path.
 * @returns the hex token.
 * @throws Error when an existing token file is unreadable or malformed.
 */
export async function ensurePetToken(path: string): Promise<string> {
  let value: string
  try {
    value = (await readFile(path, 'utf8')).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`pet-app: cannot read the access token ${JSON.stringify(path)}: ${String(error)}`, { cause: error })
    }
    const created = randomBytes(TOKEN_BYTES).toString('hex')
    await writeFileAtomic(path, `${created}\n`, { mode: 0o600, dirMode: 0o700 })
    return created
  }
  if (!usable(value)) {
    throw new Error(`pet-app: the access token file ${JSON.stringify(path)} does not hold a hex token; delete it and restart dsh`)
  }
  return value
}

/** The three URLs the worker advertises, all carrying the access token. */
export interface PetUrls {
  /** Human-facing pet page. */
  readonly page: string
  /** MCP endpoint Codex connects to. */
  readonly mcp: string
}

/**
 * Build the page and MCP URLs for one bound server.
 * @param origin - server origin such as `http://127.0.0.1:3080`.
 * @param pagePath - absolute page path.
 * @param mcpPath - absolute MCP path.
 * @param token - pet access token.
 * @returns the two token-carrying URLs.
 */
export function petUrls(origin: string, pagePath: string, mcpPath: string, token: string): PetUrls {
  const query = `?token=${encodeURIComponent(token)}`
  return { page: `${origin}${pagePath}${query}`, mcp: `${origin}${mcpPath}${query}` }
}
