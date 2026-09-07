#!/usr/bin/env node
// Preflight for the web profile, run by scripts/start-web.bat before booting.
//
// Catches the two failure classes that have actually taken the harness down:
//   1. An overlay that no longer parses (`dsh --dump-config` fails).
//   2. An entry that injects `!!js process.env.X` into `config` while X is unset.
//      `env` is typed `dict(String)`; an undefined value fails schema validation and
//      ONE bad entry aborts the whole plugin tree, so the server never binds :3080.
// Exit code 1 means "do not boot, fix this first". Warnings never block the boot.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import yaml from 'js-yaml'

const repoRoot = resolve(import.meta.dirname, '..')
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profile = process.argv[2] || 'web'

const errors = []
const warnings = []
const notes = []

/** Register the loader's `!!js` scalar tag so dumped expressions survive the parse. */
const JS_EXPR = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
})
const SCHEMA = yaml.DEFAULT_SCHEMA.extend([JS_EXPR])

// ---- 1. Compose the profile tree -------------------------------------------------
let dumped
try {
  dumped = execFileSync(
    process.execPath,
    [join(repoRoot, 'apps', 'cli', 'lib', 'bin.js'), '--profile', profile, '--dump-config'],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 },
  )
} catch (error) {
  const detail = [error.stderr, error.stdout, error.message].filter(Boolean).join('\n').trim()
  errors.push(`profil agaci derlenemedi (dsh --dump-config):\n${indent(detail)}`)
  report()
}

let entries = []
try {
  entries = (yaml.load(dumped, { schema: SCHEMA }) || []).filter((entry) => entry && typeof entry === 'object')
} catch (error) {
  errors.push(`--dump-config ciktisi ayristirilamadi: ${String(error)}`)
  report()
}

// ---- 2. Entry-level checks -------------------------------------------------------
for (const entry of entries) {
  const id = entry.id || entry.name || '<isimsiz>'
  if (entry.disabled === true) continue

  const guardRefs = [...new Set(jsExprEnvRefs(entry.disabled))].filter((name) => !process.env[name])
  if (guardRefs.length) notes.push(`${id}: ${guardRefs.join(', ')} tanimsiz — entry devre disi kalacak.`)

  const guarded = entry.disabled !== undefined
  const missing = [...new Set(unresolvableDictRefs(entry.config))]

  if (missing.length && guarded) {
    notes.push(`${id}: ${missing.join(', ')} tanimsiz ama entry zaten devre disi.`)
  } else if (missing.length) {
    errors.push(
      `${id}: config icinde ${missing.join(', ')} kullaniliyor ama ortamda tanimli degil.\n`
      + `    Bu entry "invalid config" ile patlar ve TUM boot'u dusurur.\n`
      + `    Cozum: entry'ye "disabled: !!js \\"!process.env.${missing[0]}\\"" ekleyin`
      + ` veya degeri "!!js \\"process.env.${missing[0]} ?? ''\\"" yapin.`,
    )
  }

  const cwd = entry.config?.cwd
  if (typeof cwd === 'string' && cwd && !existsSync(cwd)) {
    errors.push(`${id}: cwd bulunamadi -> ${cwd}`)
  }
}

// ---- 3. Varsayilan modelin anahtari ----------------------------------------------
try {
  const settingsPath = join(dshHome, 'settings.yaml')
  if (existsSync(settingsPath)) {
    const settings = yaml.load(readFileSync(settingsPath, 'utf8'), { schema: SCHEMA }) || {}
    const providerId = settings['agent-default-model']?.provider
    const provider = settings['llm-pi-ai']?.providers?.[providerId]
    const keyEnv = provider?.apiKeyEnv
    if (keyEnv && !process.env[keyEnv] && !credentialRefs().includes(keyEnv)) {
      warnings.push(
        `varsayilan model saglayicisi "${providerId}" ${keyEnv} istiyor;`
        + ` ne ortamda ne de .credentials.yaml icinde var — sohbet "prompt failed" verebilir.`,
      )
    }
  }
} catch (error) {
  warnings.push(`settings.yaml okunamadi: ${String(error)}`)
}

report()

// ---- helpers ---------------------------------------------------------------------

/** Env var names a single `!!js` node references, e.g. a `disabled:` guard. */
function jsExprEnvRefs(node) {
  const expr = node?.__jsExpr
  if (typeof expr !== 'string') return []
  return [...expr.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1])
}

/**
 * Unset env vars injected into a string dictionary (`env` for stdio, `headers` for
 * streamable-http). Those two are typed `dict(String)`, so an undefined value is
 * always a schema violation — unlike ordinary optional fields elsewhere in the tree,
 * where a bare `!!js process.env.X` is legitimately allowed to be undefined.
 * An expression carrying a `??` / `||` fallback can never resolve to undefined.
 */
function unresolvableDictRefs(config) {
  const dicts = [config?.env, config?.headers].filter((dict) => dict && typeof dict === 'object')
  return dicts.flatMap((dict) => Object.values(dict).flatMap((value) => {
    const expr = value?.__jsExpr
    if (typeof expr !== 'string' || /\?\?|\|\|/.test(expr)) return []
    return [...expr.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)]
      .map((match) => match[1])
      .filter((name) => !process.env[name])
  }))
}

/** Key names stored in the credential vault, so a vaulted key is not reported missing. */
function credentialRefs() {
  try {
    const vault = yaml.load(readFileSync(join(dshHome, '.credentials.yaml'), 'utf8'), { schema: SCHEMA }) || {}
    return Object.keys(vault.refs || {})
  } catch {
    return []
  }
}

function indent(text) {
  return text.split(/\r?\n/).map((line) => `    ${line}`).join('\n')
}

function report() {
  for (const note of notes) console.log(`  [bilgi]  ${note}`)
  for (const warning of warnings) console.log(`  [uyari]  ${warning}`)
  for (const error of errors) console.log(`  [HATA]   ${error}`)
  if (!errors.length && !warnings.length && !notes.length) console.log('  [ok]     profil yapilandirmasi temiz.')
  process.exit(errors.length ? 1 : 0)
}
