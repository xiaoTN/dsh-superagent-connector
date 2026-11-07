// Explicit installer: validates the exact published binary before changing an installed plugin.
// Run while the native board has no active execution, then reload its Host plugin.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { NATIVE_BOARD_HASH, NATIVE_BOARD_VERSION, originalNativeBoard, patchNativeBoard } from '../src/native-guard.js'
const profile = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop')
const root = resolve(profile, 'node_modules', '@linxin666', 'dsh-client-ui-task-board')
const meta = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (meta.version !== NATIVE_BOARD_VERSION) throw new Error('Unsupported task-board version; no files changed')
const path = join(root, 'lib', 'index.js')
const source = readFileSync(path, 'utf8')
const patched = patchNativeBoard(source)
if (patched === source) { console.log('Existing native task-board guard is already installed.'); process.exit(0) }
const backupRoot = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'superagent-connector-backup')
mkdirSync(backupRoot, { recursive: true })
const backup = join(backupRoot, 'taskboard-' + NATIVE_BOARD_VERSION + '-' + NATIVE_BOARD_HASH + '.js')
const baseline = originalNativeBoard(source)
if (existsSync(backup)) {
  if (createHash('sha256').update(readFileSync(backup)).digest('hex') !== NATIVE_BOARD_HASH) throw new Error('Original backup differs; refusing to overwrite or continue')
} else writeFileSync(backup, baseline, { flag: 'wx' })
writeFileSync(path, patched)
console.log('Patched the existing task board admission; original backup saved under DSH_HOME/superagent-connector-backup.')
console.log('Patched SHA256: ' + createHash('sha256').update(patched).digest('hex'))
console.log('Reload the native board Host plugin before enabling Superagent sync. No DSH core/shell files changed.')
