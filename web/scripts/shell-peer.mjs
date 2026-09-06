// 壳验证:第二台设备向壳内的 TTW 发文本 + 图片 + 压缩包
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE = 'http://localhost:7317'
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage()
await page.goto(BASE)
await page.waitForSelector('text=欢迎使用 Noobty', { timeout: 10000 })
await page.getByLabel('给这台设备起个名字').fill('测试手机')
await page.getByRole('button', { name: '进入' }).click()
await page.waitForSelector('text=这台设备', { timeout: 10000 })
await page.waitForTimeout(800)

await page.getByText('TTW').first().waitFor({ timeout: 8000 })
await page.getByText('TTW').first().click()
await page.waitForTimeout(500)

await page.getByPlaceholder('输入文字,或直接拖入、粘贴文件').fill('壳验证:收到请通知')
await page.keyboard.press('Enter')
await page.waitForTimeout(600)

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8Dwn4EIwESMolGFSQEAT4gF/lK2dPcAAAAASUVORK5CYII=',
  'base64',
)
writeFileSync(resolve('.shots', '__shell-photo.png'), png)
await page.setInputFiles('input[type=file]', resolve('.shots', '__shell-photo.png'))
await page.waitForTimeout(1200)

writeFileSync(resolve('.shots', '__shell-备档.zip'), Buffer.alloc(300 * 1024, 5))
await page.setInputFiles('input[type=file]', resolve('.shots', '__shell-备档.zip'))
await page.waitForTimeout(1500)
console.log('SENT_ALL')
await browser.close()
