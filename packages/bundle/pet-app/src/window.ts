/**
 * Open the pet as a transparent, frameless, always-on-top Electron window. The
 * worker itself stays a Node process; this module only launches the viewer and
 * falls back to the default browser when no Electron executable is available.
 *
 * @module @deepseek-ai/dsh-pet-app/window
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Which viewer the worker opens after readiness. */
export type WindowMode = 'auto' | 'electron' | 'browser' | 'none'

/** Viewer launch inputs. */
export interface PetWindowOptions {
  /** Token-carrying pet page URL. */
  readonly pageUrl: string
  /** Requested viewer. */
  readonly mode: WindowMode
  /** Explicit Electron executable or package directory. */
  readonly electronPath?: string
  /** Diagnostic sink for a failed fallback or a crashed viewer. */
  readonly log: (message: string) => void
}

/** A launched viewer. */
export interface PetWindowHandle {
  /** Close the viewer, if this worker owns it. */
  close(): Promise<void>
}

/** Load an Electron package directory and return its executable path. */
function executableFromPackage(directory: string): string | undefined {
  try {
    const loaded: unknown = createRequire(join(directory, 'package.json'))(directory)
    return typeof loaded === 'string' ? loaded : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve an Electron executable without declaring Electron as a runtime
 * dependency: an explicit path wins, then the package this installation can
 * resolve, then the checkout's Desktop application (development only).
 * @param configured - explicit path from config.
 * @returns the executable path, or undefined when this installation has none.
 */
export function resolveElectron(configured?: string): string | undefined {
  const explicit = configured ?? process.env.DSH_PET_ELECTRON
  if (explicit !== undefined && explicit !== '') {
    if (existsSync(explicit)) {
      if (!existsSync(join(explicit, 'package.json'))) return explicit
      const fromPackage = executableFromPackage(explicit)
      if (fromPackage !== undefined && existsSync(fromPackage)) return fromPackage
    }
    return undefined
  }
  try {
    const resolved: unknown = createRequire(import.meta.url)('electron')
    if (typeof resolved === 'string' && existsSync(resolved)) return resolved
  } catch {
    // No Electron dependency; the Desktop application fallback comes next.
  }
  try {
    const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
    const desktop = join(repoRoot, 'apps', 'desktop')
    if (existsSync(join(desktop, 'package.json'))) {
      const resolved: unknown = createRequire(join(desktop, 'package.json'))('electron')
      if (typeof resolved === 'string' && existsSync(resolved)) return resolved
    }
  } catch {
    // A published installation has no checkout beside it.
  }
  return undefined
}

/** Launch the Electron main script with a clean GUI environment. */
function spawnElectron(executable: string, pageUrl: string, log: (message: string) => void): PetWindowHandle {
  const script = fileURLToPath(new URL('../assets/pet-window.mjs', import.meta.url))
  const environment: NodeJS.ProcessEnv = { ...process.env }
  // A worker started by the Desktop Host inherits Electron's Node mode; the
  // viewer must be a GUI process instead.
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ELECTRON_NO_ATTACH_CONSOLE
  const child: ChildProcess = spawn(executable, [script, pageUrl], {
    env: environment,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: false,
  })
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192) })
  child.once('error', (error: Error) => { log(`pet-app: cannot start the Electron pet window: ${error.message}`) })
  child.once('exit', (code) => {
    if (code !== 0 && code !== null) log(`pet-app: the Electron pet window exited with code ${String(code)}${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`)
  })
  return {
    close: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      return Promise.resolve()
    },
  }
}

/**
 * Open the configured viewer once the worker is ready.
 * @param options - page URL, requested mode, and diagnostics.
 * @returns the viewer handle; a browser handoff is not owned and has a no-op close.
 * @throws Error when `electron` was requested explicitly and no executable exists.
 */
export async function openPetWindow(options: PetWindowOptions): Promise<PetWindowHandle> {
  if (options.mode === 'none') return { close: async () => {} }
  const electron = resolveElectron(options.electronPath)
  if (electron !== undefined && options.mode !== 'browser') return spawnElectron(electron, options.pageUrl, options.log)
  if (options.mode === 'electron') {
    throw new Error('pet-app: Electron was requested but no executable was found; set electronPath or DSH_PET_ELECTRON to an Electron executable')
  }
  const { default: open } = await import('open')
  await open(options.pageUrl)
  options.log('pet-app: no Electron executable found; opened the pet page in the default browser')
  return { close: async () => {} }
}
