// 局域网中枢邀请二维码:本地编码,不依赖外网短链服务。
import { renderSVG } from 'uqr'

/** 中枢完整 URL → SVG 二维码(深色模块用 currentColor,随主题变色)。 */
export function hubInviteQrSvg(url: string): string {
  return renderSVG(url, {
    ecc: 'M',
    border: 2,
    pixelSize: 5,
    blackColor: 'currentColor',
    whiteColor: 'transparent',
  })
}
