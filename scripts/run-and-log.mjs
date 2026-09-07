#!/usr/bin/env node
// Runs a command with its output going to BOTH the console (live) and a log file.
//
// cmd.exe has no `tee`. Plain `> file` redirection leaves the launcher window silent
// for the ~minute the harness takes to boot, which reads as "frozen" and invites a
// Ctrl+C. Piping through PowerShell's Tee-Object is worse: it buffers the stream and
// rewrites the child's stderr into error records, so the log ends up both mangled and
// missing its last lines — exactly the lines the failure path needs to print.
//
// Usage: node run-and-log.mjs <logPath> <command> [args...]

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'

const [logPath, command, ...args] = process.argv.slice(2)
if (!logPath || !command) {
  console.error('usage: node run-and-log.mjs <logPath> <command> [args...]')
  process.exit(2)
}

// Go through cmd.exe explicitly rather than `shell: true`: the shell option
// concatenates argv without escaping (Node DEP0190) and swallowed the child's
// exit code in testing, which the launcher relies on to spot a failed boot.
const quote = (arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg)
const commandLine = [command, ...args].map(quote).join(' ')

const log = createWriteStream(logPath, { flags: 'w' })
const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], {
  stdio: ['inherit', 'pipe', 'pipe'],
  windowsHide: false,
})

const forward = (source, sink) => source.on('data', (chunk) => {
  sink.write(chunk)
  log.write(chunk)
})
forward(child.stdout, process.stdout)
forward(child.stderr, process.stderr)

// Ctrl+C already reaches the child through the console's process group; swallow it
// here so this wrapper stays alive long enough to flush the log the child just wrote.
process.on('SIGINT', () => {})

child.on('error', (error) => {
  const message = `run-and-log: ${command} baslatilamadi: ${error.message}\n`
  process.stderr.write(message)
  log.end(message, () => process.exit(1))
})

child.on('exit', (code, signal) => {
  log.end(() => process.exit(code ?? (signal ? 1 : 0)))
})
