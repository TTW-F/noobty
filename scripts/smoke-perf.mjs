#!/usr/bin/env node
/**
 * Windows-friendly smoke for perf-touched paths (upload/download/range/relay/file_group).
 * Usage: node scripts/smoke-perf.mjs [port]
 */
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const PORT = Number(process.argv[2] || 7431)
const BASE = `http://127.0.0.1:${PORT}`
const TMP = mkdtempSync(join(tmpdir(), 'noobty-smoke-'))
let failures = 0
let child

function pass(msg) {
  console.log('  OK ', msg)
}
function fail(msg) {
  console.log('  FAIL', msg)
  failures++
}
function check(desc, exp, act) {
  if (String(exp) === String(act)) pass(desc)
  else fail(`${desc} (expected [${exp}], got [${act}])`)
}

async function jfetch(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, opts)
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body, text }
}

function findBin() {
  const cands = [
    join(ROOT, 'server/target/release/noobty-server.exe'),
    join(ROOT, 'server/target/release/noobty-server'),
    join(ROOT, 'server/target/debug/noobty-server.exe'),
    join(ROOT, 'server/target/debug/noobty-server'),
  ]
  for (const c of cands) if (existsSync(c)) return c
  throw new Error('noobty-server binary not found; cargo build --release first')
}

function tomlPath(p) {
  return JSON.stringify(p.replace(/\\/g, '/'))
}

async function main() {
  const dataDir = join(TMP, 'data')
  mkdirSync(dataDir, { recursive: true })
  const cfg = join(TMP, 'config.toml')
  writeFileSync(
    cfg,
    `port = ${PORT}\nweb_dir = ${tomlPath(join(ROOT, 'web/dist'))}\nstorage_path = ${tomlPath(dataDir)}\n`,
  )

  const bin = findBin()
  let bootLog = ''
  child = spawn(bin, [], {
    env: { ...process.env, NOOBTY_CONFIG: cfg },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => (bootLog += d))
  child.stderr.on('data', (d) => (bootLog += d))

  let healthy = false
  for (let i = 0; i < 50; i++) {
    try {
      const h = await jfetch('/api/healthz')
      if (h.body?.ok) {
        healthy = true
        break
      }
    } catch {
      /* retry */
    }
    await sleep(100)
  }
  check('healthz', true, healthy)

  const A = (await jfetch('/api/devices/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'smoke-a' }),
  })).body?.device_id
  const B = (await jfetch('/api/devices/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'smoke-b' }),
  })).body?.device_id
  check('register A', true, !!A)
  check('register B', true, !!B)
  const convId = `private:${B}`

  await jfetch(`/api/conversations/${convId}/texts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Noobty-Device': A },
    body: JSON.stringify({ text: 'hi' }),
  })

  const payload = randomBytes(256 * 1024)
  const sha = createHash('sha256').update(payload).digest('hex')
  const up = await jfetch('/api/uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Noobty-Device': A },
    body: JSON.stringify({ name: 'perf.bin', size: payload.length, sha256: sha }),
  })
  const uploadId = up.body?.upload_id
  check('upload session', true, !!uploadId)
  const chunkSize = up.body?.chunk_size || 4 * 1024 * 1024
  let offset = 0
  while (offset < payload.length) {
    const end = Math.min(offset + chunkSize, payload.length)
    const chunk = payload.subarray(offset, end)
    const put = await fetch(`${BASE}/api/uploads/${uploadId}`, {
      method: 'PUT',
      headers: {
        'X-Noobty-Device': A,
        'X-Noobty-Offset': String(offset),
        'content-type': 'application/offset+octet-stream',
      },
      body: chunk,
    })
    const putBody = await put.json()
    offset = putBody.received_bytes
  }
  const done = await jfetch(`/api/uploads/${uploadId}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Noobty-Device': A },
    body: JSON.stringify({ conversation_id: convId }),
  })
  const fileId = done.body?.file_id
  check('upload complete has file', true, !!fileId)

  const dl = await fetch(`${BASE}/api/files/${fileId}`)
  const dlBuf = Buffer.from(await dl.arrayBuffer())
  check('download size', payload.length, dlBuf.length)
  check('download sha256', sha, createHash('sha256').update(dlBuf).digest('hex'))

  const range = await fetch(`${BASE}/api/files/${fileId}`, { headers: { Range: 'bytes=0-9' } })
  check('range 206', 206, range.status)
  check('range len', 10, (await range.arrayBuffer()).byteLength)

  // Tiny 1×1 PNG for thumb endpoint
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const pngId = await (async () => {
    const s = await jfetch('/api/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Noobty-Device': A },
      body: JSON.stringify({ name: 'dot.png', size: png.length }),
    })
    await fetch(`${BASE}/api/uploads/${s.body.upload_id}`, {
      method: 'PUT',
      headers: {
        'X-Noobty-Device': A,
        'X-Noobty-Offset': '0',
        'content-type': 'application/offset+octet-stream',
      },
      body: png,
    })
    const c = await jfetch(`/api/uploads/${s.body.upload_id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Noobty-Device': A },
      body: JSON.stringify({}),
    })
    return c.body?.file_id
  })()
  check('png uploaded', true, !!pngId)
  const thumb = await fetch(`${BASE}/api/files/${pngId}/thumb`)
  check('thumb 200', 200, thumb.status)
  check('thumb jpeg', true, (thumb.headers.get('content-type') || '').includes('jpeg'))
  const inline = await fetch(`${BASE}/api/files/${pngId}?inline=1`)
  check('inline 200', 200, inline.status)
  check('inline png type', true, (inline.headers.get('content-type') || '').includes('image/png'))
  check(
    'inline disposition',
    true,
    (inline.headers.get('content-disposition') || '').toLowerCase().startsWith('inline'),
  )
  const page1 = await jfetch('/api/files?limit=1')
  const firstId = page1.body?.files?.[0]?.file_id
  const page2 = await jfetch(`/api/files?limit=1&before=${encodeURIComponent(firstId)}`)
  check('list before cursor', true, Array.isArray(page2.body?.files))

  async function uploadOnly(name, bytes) {
    const s = await jfetch('/api/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Noobty-Device': A },
      body: JSON.stringify({ name, size: bytes.length }),
    })
    const id = s.body.upload_id
    await fetch(`${BASE}/api/uploads/${id}`, {
      method: 'PUT',
      headers: {
        'X-Noobty-Device': A,
        'X-Noobty-Offset': '0',
        'content-type': 'application/offset+octet-stream',
      },
      body: bytes,
    })
    const c = await jfetch(`/api/uploads/${id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Noobty-Device': A },
      body: JSON.stringify({}),
    })
    return c.body?.file_id
  }
  const f1 = await uploadOnly('g1.bin', randomBytes(1024))
  const f2 = await uploadOnly('g2.bin', randomBytes(2048))
  check('batch files stored', true, !!f1 && !!f2)
  const grp = await jfetch(`/api/conversations/${convId}/file-groups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Noobty-Device': A },
    body: JSON.stringify({ file_ids: [f1, f2] }),
  })
  check('file_group kind', 'file_group', grp.body?.kind)
  check('file_group count', 2, (grp.body?.files || []).length)

  const hist = await jfetch(`/api/conversations/${convId}/messages?limit=50`, {
    headers: { 'X-Noobty-Device': A },
  })
  const msgs = hist.body?.messages || []
  check(
    'history hydrates file_group',
    true,
    msgs.some((m) => m.kind === 'file_group' && (m.files || []).length === 2),
  )

  // Relay: B online via WS, attach GET then PUT (BufWriter path).
  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/ws?device_id=${B}`)
    const timer = setTimeout(() => {
      fail('relay timeout')
      try {
        ws.close()
      } catch {
        /* */
      }
      resolve()
    }, 10000)

    ws.onopen = async () => {
      await sleep(200)
      const create = await jfetch('/api/relays', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Noobty-Device': A },
        body: JSON.stringify({ conversation_id: convId, name: 'relay.bin', size: 4096 }),
      })
      const relayId = create.body?.relay_id
      const relayFid = create.body?.file_id
      if (!relayId) {
        fail(`relay create: ${JSON.stringify(create.body)}`)
        clearTimeout(timer)
        ws.close()
        resolve()
        return
      }
      pass('relay created')
      const body = randomBytes(4096)
      const getP = fetch(`${BASE}/api/relays/${relayId}`, {
        headers: { 'X-Noobty-Device': B },
      })
      await sleep(150)
      const putP = fetch(`${BASE}/api/relays/${relayId}`, {
        method: 'PUT',
        headers: { 'X-Noobty-Device': A, 'content-type': 'application/octet-stream' },
        body,
      })
      const [putRes, getRes] = await Promise.all([putP, getP])
      const putJson = await putRes.json().catch(() => ({}))
      const got = Buffer.from(await getRes.arrayBuffer())
      check('relay put ok', true, putRes.ok)
      check('relay put file_id', relayFid, putJson.file_id)
      check('relay live bytes', 4096, got.length)
      check('relay bytes match', true, got.equals(body))
      const disk = Buffer.from(await (await fetch(`${BASE}/api/files/${relayFid}`)).arrayBuffer())
      check('relay disk tee', true, disk.equals(body))
      clearTimeout(timer)
      ws.close()
      resolve()
    }
    ws.onerror = () => {
      fail('ws for relay')
      clearTimeout(timer)
      resolve()
    }
  })

  if (failures) {
    console.log(`\nSMOKE-PERF FAILED: ${failures}`)
    console.log('server log:\n', bootLog.slice(-2500))
    process.exitCode = 1
  } else {
    console.log('\nSMOKE-PERF OK')
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => {
    if (child) {
      try {
        child.kill()
      } catch {
        /* */
      }
    }
    try {
      rmSync(TMP, { recursive: true, force: true })
    } catch {
      /* */
    }
  })
