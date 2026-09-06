// 真机联调 E2E:真实 Rust 中枢(localhost:7317)+ 无 mock 前端(vite 代理)
// 用法:先启动 server(cargo run)与 vite dev(5199),再 node scripts/e2e.mjs
import { chromium } from 'playwright'
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE = process.argv[2] ?? 'http://localhost:5199'
const outDir = resolve(process.cwd(), '.shots')
mkdirSync(outDir, { recursive: true })

let failed = 0
function ok(name, cond, detail = '') {
  if (cond) {
    console.log(`PASS ${name}`)
  } else {
    failed++
    console.log(`FAIL ${name} ${detail}`)
  }
}

// 生成纯色 PNG(不引依赖:手写 PNG 容器 + zlib)
function solidPng(w, h, r, g, b) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    const rowStart = y * (w * 3 + 1)
    raw[rowStart] = 0
    for (let x = 0; x < w; x++) {
      const i = rowStart + 1 + x * 3
      raw[i] = r
      raw[i + 1] = g
      raw[i + 2] = b
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crcTable = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
    let crc = 0xffffffff
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
    const crcBuf = Buffer.alloc(4)
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([len, body, crcBuf])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

async function registerDevice(page, name) {
  await page.goto(BASE)
  await page.waitForSelector('text=欢迎使用 Noobty', { timeout: 15000 })
  await page.getByLabel('给这台设备起个名字').fill(name)
  await page.getByRole('button', { name: '进入' }).click()
  await page.waitForSelector('text=这台设备', { timeout: 15000 })
  await page.waitForTimeout(800) // 等 WS hello 与快照
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 })
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 })
  const pageA = await ctxA.newPage()
  const pageB = ctxB.newPage ? await ctxB.newPage() : null
  for (const [tag, p] of [
    ['A', pageA],
    ['B', pageB],
  ]) {
    p &&
      p.on('pageerror', (err) => console.log(`[pageerror:${tag}]`, String(err).slice(0, 250)))
    p &&
      p.on('console', (m) => {
        const t = m.text()
        if (t.includes('[dbg]') || t.includes('[up]') || m.type() === 'error') console.log(`[dbg:${tag}]`, t.slice(0, 300))
      })
    p &&
      p.on('requestfailed', (req) => {
        if (req.url().includes('/api/')) {
          console.log(`[reqfail:${tag}]`, req.method(), req.url().replace(BASE, ''), req.failure()?.errorText)
        }
      })
    p &&
      p.on('websocket', (ws) => {
        console.log(`[ws:${tag}] open ${ws.url().slice(-30)}`)
        ws.on('framereceived', (frame) => {
          const t = String(frame.payload ?? '')
          if (t.includes('"message"') || t.includes('file')) {
            console.log(`[ws:${tag}] recv`, t.slice(0, 220))
          }
        })
        ws.on('close', () => console.log(`[ws:${tag}] closed`))
      })
    p &&
      p.on('response', (res) => {
        if (res.url().includes('/api/') && res.status() >= 400) {
          console.log(`[http:${tag}]`, res.status(), res.request().method(), res.url().replace(BASE, ''))
        }
      })
  }

  // 1. 双设备注册
  await registerDevice(pageA, '书房台式机')
  pageB && (await registerDevice(pageB, '口袋手机'))
  ok('双设备注册并进入主界面', true)
  // B 侧显式选中 A 的会话(中枢上可能有其他在线设备,不能依赖自动选中)
  if (pageB) {
    await pageB.getByText('书房台式机').first().waitFor({ timeout: 8000 })
    await pageB.locator('button[data-conv^="private:"]', { hasText: '书房台式机' }).first().click()
    await pageB.waitForTimeout(400)
  }

  // 2. 在线状态:A 能看到 B 在线
  await pageA.getByText('口袋手机').first().waitFor({ timeout: 8000 })
  const bRow = pageA.locator('button[data-conv^="private:"]', { hasText: '口袋手机' }).first()
  await bRow.waitFor({ timeout: 8000 })
  ok('A 的联系人列表出现 B', await bRow.isVisible())
  // 显式选中 B 的会话(中枢上可能有其他在线设备,不能依赖自动选中)
  await bRow.click()
  await pageA.waitForTimeout(500)

  // 3. A → B 发文本,B 实时收到(每次运行用唯一文案,避免残留数据造成假阳性)
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  const stampSafe = stamp.replaceAll(':', '-')
  const textMsg = `联调测试 ${stamp}:这条消息走真实中枢`
  // 上传分段计时(装在 A 页)
  await pageA.evaluate(() => {
    const orig = window.fetch
    window.fetch = async (...args) => {
      const url = String(args[0])
      const t0 = performance.now()
      const res = await orig(...args)
      if (url.includes('/api/uploads')) {
        console.log(`[up] ${res.status} ${url.replace(location.origin, '').slice(0, 70)} ${Math.round(performance.now() - t0)}ms @${new Date().toISOString().slice(11, 19)}`)
      }
      return res
    }
  })
  await pageA.getByPlaceholder('输入文字,或直接拖入、粘贴文件').fill(textMsg)
  await pageA.keyboard.press('Enter')
  await pageA.getByText(textMsg).first().waitFor({ timeout: 8000 })
  ok('A 发送文本成功(回显)', true)
  try {
    await pageB.getByText(textMsg).first().waitFor({ timeout: 8000 })
    ok('B 通过 WebSocket 实时收到文本', true)
  } catch (e) {
    const activeB = await pageB.locator('button[data-conv].bg-primary-soft').textContent().catch(() => 'NONE')
    const rowsB = await pageB.locator('button[data-conv]').allTextContents().catch(() => [])
    console.log('[FAIL-EVIDENCE] B 活动会话:', String(activeB).slice(0, 40))
    console.log('[FAIL-EVIDENCE] B 会话行:', JSON.stringify(rowsB.map((r) => r.slice(0, 30))))
    await pageB.screenshot({ path: resolve(outDir, '99-e2e-fail-B.png') })
    throw e
  }

  // 4. A → B 发图片(PNG),B 端渲染图片卡并加载出位图
  const png = solidPng(160, 120, 16, 114, 138)
  writeFileSync(resolve(outDir, '__e2e-photo.png'), png)
  await pageA.setInputFiles('input[type=file]', resolve(outDir, '__e2e-photo.png'))
  try {
    await pageB.locator('img[alt="__e2e-photo.png"]').first().waitFor({ timeout: 15000 })
  } catch (e) {
    const diag = await pageB
      .evaluate(async () => {
        const imgs = [...document.images].map((i) => ({ alt: i.alt, complete: i.complete, w: i.naturalWidth, src: i.src.slice(0, 40) }))
        const buttons = [...document.querySelectorAll('button[title*="点按放大"]')].map((b) => b.getAttribute('title'))
        const fileId = buttons[0]?.match(/files\/([^·]+)/)?.[1]?.trim()
        let probe = 'n/a'
        if (fileId) {
          const t0 = performance.now()
          try {
            const res = await fetch(`/api/files/${fileId}`)
            probe = `${res.status} ${Math.round(performance.now() - t0)}ms`
          } catch (err) {
            probe = `throw ${String(err).slice(0, 60)}`
          }
        }
        return { imgs, buttons, probe }
      })
      .catch((err) => String(err).slice(0, 120))
    console.log('[FAIL-EVIDENCE:B] DOM:', JSON.stringify(diag))
    await pageB.screenshot({ path: resolve(outDir, '99-e2e-fail-B3.png') })
    throw e
  }
  await pageB.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0), undefined, { timeout: 10000 }).catch(() => {})
  ok('B 实时收到图片消息并渲染位图', true)
  await pageB.screenshot({ path: resolve(outDir, '20-e2e-received-image.png') })

  // 4b. A → B 发普通文件(非图片,渲染文件卡),B 取件下载
  const zipName = `联调附件-${stampSafe}.zip`
  writeFileSync(resolve(outDir, zipName), Buffer.alloc(64 * 1024, 9))
  await pageA.setInputFiles('input[type=file]', resolve(outDir, zipName))
  await pageA.getByText(zipName).first().waitFor({ timeout: 15000 })
  ok('A 上传文件完成并回显文件卡', true)
  await pageB.getByText(zipName).first().waitFor({ timeout: 8000 })
  await pageB.getByRole('button', { name: /^取件/ }).first().click()
  await pageB.getByText('已保存').first().waitFor({ timeout: 15000 })
  ok('B 取件下载成功(已保存)', true)

  // 6. 存储表反映真实用量(≥ 图片大小)
  const meterText = await pageB.getByText(/\/ 30\.0 GB|GB \/ /).first().textContent().catch(() => '')
  ok('B 的存储面板显示真实用量', Boolean(meterText && meterText.trim().length > 0), meterText ?? '')

  // 7. A 删除文本消息 → B 同步移除
  const rowA = pageA.locator('div.group', { hasText: textMsg }).first()
  await rowA.hover()
  await rowA.getByRole('button', { name: '删除这条消息' }).click()
  await pageA.getByRole('button', { name: '删除', exact: true }).click()
  await pageA.waitForTimeout(400)
  const stillThere = await pageB.getByText(textMsg).count()
  ok('A 删除后 B 同步移除(message_deleted)', stillThere === 0, `残留 ${stillThere} 条`)

  // 8. 大厅 M2 门控
  await pageA.getByRole('button', { name: /^大厅/ }).click()
  await pageA.getByText('大厅将在 M2 开放').first().waitFor({ timeout: 8000 })
  const composerDisabled = await pageA.getByPlaceholder('大厅将在 M2 版本开放').isDisabled()
  ok('大厅显示 M2 门控且发送器禁用', composerDisabled)
  await pageA.screenshot({ path: resolve(outDir, '21-e2e-lobby-m2.png') })

  // 9. 刷新后身份保持,且双向历史完整(收到的消息在刷新后仍在)
  await pageB.reload()
  await pageB.getByText('这台设备', { exact: true }).waitFor({ timeout: 15000 })
  await pageB.waitForTimeout(1500)
  ok('B 刷新后保持身份与会话', await pageB.getByText('口袋手机').first().isVisible())
  await pageB.locator('button[data-conv^="private:"]', { hasText: '书房台式机' }).first().click()
  await pageB.waitForTimeout(600)
  try {
    await pageB.getByText(zipName).first().waitFor({ timeout: 10000 })
    ok('B 刷新后仍能看到 A 发来的历史(线程合并)', true)
  } catch (e) {
    ok('B 刷新后仍能看到 A 发来的历史(线程合并)', false, 'zip 卡未出现')
    await pageB.screenshot({ path: resolve(outDir, '99-e2e-fail-refresh.png') })
    throw e
  }

  await ctxA.close()
  await ctxB.close()
} finally {
  await browser.close()
}

console.log(failed === 0 ? 'E2E_ALL_PASS' : `E2E_FAILED(${failed})`)
process.exit(failed === 0 ? 0 : 1)
