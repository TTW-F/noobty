// 视觉验收截图:?mock=1 的应用在各状态下的渲染
// 用法:node scripts/shoot.mjs [端口]  输出到 web/.shots/
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const port = process.argv[2] ?? '5199'
const base = `http://localhost:${port}`
const outDir = resolve(process.cwd(), '.shots')
mkdirSync(outDir, { recursive: true })

const IDENTITY = JSON.stringify({ device_id: 'self-device', name: '客厅笔记本' })

async function shoot(browser) {
  // ---- 桌面(已注册) ----
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 })
  await desktop.addInitScript(([id]) => localStorage.setItem('noobty.device.v1', id), [IDENTITY])
  const page = await desktop.newPage()

  await page.goto(`${base}/?mock=1`)
  await page.waitForSelector('text=大厅', { timeout: 15000 })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(600)

  // 01 大厅(亮)
  await page.screenshot({ path: resolve(outDir, '01-lobby-light.png') })

  // 02 私聊:书房台式机(亮,含文件卡)
  await page.getByText('书房台式机').first().click()
  await page.waitForTimeout(450)
  await page.screenshot({ path: resolve(outDir, '02-private-desk-light.png') })

  // 03 私聊:小米手机(亮,含图片卡与侧栏未读)
  await page.getByText('小米手机').first().click()
  await page.waitForFunction(() => [...document.images].every((i) => i.complete), undefined, { timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(400)
  await page.screenshot({ path: resolve(outDir, '03-private-phone-image-light.png') })

  // 13 图片灯箱(亮):点按图片放大
  await page.getByTitle(/点按放大/).first().click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: resolve(outDir, '13-lightbox-light.png') })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  // 04 卧室笔记本(亮,文件组卡)
  await page.getByText('卧室笔记本').first().click()
  await page.waitForTimeout(450)
  await page.screenshot({ path: resolve(outDir, '04-private-laptop-group-light.png') })

  // 05 同会话(暗)
  await page.getByLabel('切换到暗色').click()
  await page.waitForTimeout(350)
  await page.screenshot({ path: resolve(outDir, '05-private-laptop-group-dark.png') })

  // 06 书房台式机(暗,文件卡)
  await page.getByText('书房台式机').first().click()
  await page.waitForTimeout(450)
  await page.screenshot({ path: resolve(outDir, '06-private-desk-dark.png') })

  // 07 空态:客人的 iPhone(暗)
  await page.getByText('客人的 iPhone').first().click()
  await page.waitForTimeout(450)
  await page.screenshot({ path: resolve(outDir, '07-empty-dark.png') })

  // 14 存储面板展开(暗)
  await page.getByRole('button', { name: /寄存空间/ }).click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: resolve(outDir, '14-storage-expanded-dark.png') })
  await page.getByRole('button', { name: /寄存空间/ }).click()
  await page.waitForTimeout(300)

  // 08 上传中队列(暗,回书房台式机;两个较大的文件保证队列可见)
  await page.getByText('书房台式机').first().click()
  const big = Buffer.alloc(48 * 1024 * 1024, 7)
  const mid = Buffer.alloc(36 * 1024 * 1024, 3)
  writeFileSync(resolve(outDir, '视频剪辑-粗剪.mov'), big)
  writeFileSync(resolve(outDir, '相机原图.zip'), mid)
  await page.setInputFiles('input[type=file]', [
    resolve(outDir, '视频剪辑-粗剪.mov'),
    resolve(outDir, '相机原图.zip'),
  ])
  await page.waitForTimeout(700)
  await page.screenshot({ path: resolve(outDir, '08-uploading-dark.png') })
  await page.waitForTimeout(9000) // 等上传完成再继续,避免残留

  // ---- 移动端(390×844) ----
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  })
  await mobile.addInitScript(([id]) => localStorage.setItem('noobty.device.v1', id), [IDENTITY])
  const mpage = await mobile.newPage()
  await mpage.goto(`${base}/?mock=1`)
  await mpage.waitForSelector('text=大厅', { timeout: 15000 })
  await mpage.evaluate(() => document.fonts.ready)
  await mpage.waitForTimeout(500)

  // 09 移动端列表(亮)
  await mpage.screenshot({ path: resolve(outDir, '09-mobile-list-light.png') })

  // 10 移动端会话:先在列表屏切到暗色(主题按钮在侧栏底部),再进入会话
  await mpage.getByLabel('切换到暗色').tap()
  await mpage.waitForTimeout(350)
  await mpage.getByText('小米手机').first().tap()
  await mpage.waitForFunction(() => [...document.images].every((i) => i.complete), undefined, { timeout: 8000 }).catch(() => {})
  await mpage.waitForTimeout(400)
  await mpage.screenshot({ path: resolve(outDir, '10-mobile-chat-dark.png') })

  // ---- 回到底部按钮(矮视口让消息溢出) ----
  const short = await browser.newContext({ viewport: { width: 1440, height: 520 }, deviceScaleFactor: 2 })
  await short.addInitScript(([id]) => localStorage.setItem('noobty.device.v1', id), [IDENTITY])
  const spage = await short.newPage()
  await spage.goto(`${base}/?mock=1`)
  await spage.waitForSelector('text=大厅', { timeout: 15000 })
  await spage.waitForTimeout(600)
  await spage.evaluate(() => {
    const el = document.querySelector('[role="log"]')
    if (el) el.scrollTop = 0
  })
  await spage.waitForTimeout(400)
  // 15 回到底部按钮(亮,矮视口)
  await spage.screenshot({ path: resolve(outDir, '15-jump-button-light.png') })
  await short.close()

  // ---- 注册引导(全新上下文) ----
  const fresh = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 })
  const fpage = await fresh.newPage()
  await fpage.goto(`${base}/?mock=1`)
  await fpage.waitForSelector('text=欢迎使用 Noobty', { timeout: 15000 })
  await fpage.evaluate(() => document.fonts.ready)
  await fpage.waitForTimeout(400)

  // 11 引导屏(亮)
  await fpage.screenshot({ path: resolve(outDir, '11-register-light.png') })

  // 12 引导屏(暗)
  await fpage.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
    localStorage.setItem('noobty.theme', 'dark')
  })
  await fpage.waitForTimeout(350)
  await fpage.screenshot({ path: resolve(outDir, '12-register-dark.png') })

  await desktop.close()
  await mobile.close()
  await fresh.close()
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  await shoot(browser)
  console.log('SHOTS_DONE')
} finally {
  await browser.close()
}
