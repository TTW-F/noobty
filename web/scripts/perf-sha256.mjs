#!/usr/bin/env node
/**
 * Microbench: arrayBuffer+subtle vs streaming @noble/hashes SHA-256.
 * Run: node scripts/perf-sha256.mjs
 * Fixed sizes; reports wall ms (Node). Browser heap needs DevTools separately.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

const SIZES_MIB = [16, 64, 128]
const RUNS = 3

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}
function stdev(xs) {
  const m = mean(xs)
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)))
}

async function benchSubtle(buf) {
  const t0 = performance.now()
  const dig = await crypto.subtle.digest('SHA-256', buf)
  const ms = performance.now() - t0
  return { ms, hex: Buffer.from(dig).toString('hex') }
}

function benchNoble(buf) {
  const t0 = performance.now()
  const hasher = sha256.create()
  const chunk = 1024 * 1024
  for (let i = 0; i < buf.length; i += chunk) {
    hasher.update(buf.subarray(i, Math.min(i + chunk, buf.length)))
  }
  const hex = bytesToHex(hasher.digest())
  return { ms: performance.now() - t0, hex }
}

function benchNode(buf) {
  const t0 = performance.now()
  const hex = createHash('sha256').update(buf).digest('hex')
  return { ms: performance.now() - t0, hex }
}

console.log('SHA-256 microbench (Node). Peak heap: arrayBuffer path ≈ file size; stream path ≈ chunk.\n')

for (const mib of SIZES_MIB) {
  const buf = randomBytes(mib * 1024 * 1024)
  const subtleMs = []
  const nobleMs = []
  let refHex

  for (let i = 0; i < RUNS; i++) {
    const n = benchNode(buf)
    refHex = n.hex
    const s = await benchSubtle(buf)
    const b = benchNoble(buf)
    if (s.hex !== refHex || b.hex !== refHex) {
      console.error('digest mismatch')
      process.exit(1)
    }
    subtleMs.push(s.ms)
    nobleMs.push(b.ms)
  }

  console.log(
    `${mib} MiB ×${RUNS}: subtle ${mean(subtleMs).toFixed(0)}±${stdev(subtleMs).toFixed(0)} ms | ` +
      `noble-stream ${mean(nobleMs).toFixed(0)}±${stdev(nobleMs).toFixed(0)} ms | ` +
      `heap model: subtle O(n) vs noble O(1MiB chunk)`,
  )
}

console.log('\nOK — digests match node:crypto. Record means in docs/PERF.md.')
