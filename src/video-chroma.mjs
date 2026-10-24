/**
 * 抠像（chroma key）与整图合成 —— 纯本地、零计费。
 *
 * 主判据是**从画面四边出发的洪水填充**，而不是「绿色优势值」：
 * 视频模型（H3 / 海螺 / 各家图生视频）经常把纯色背景重新打光成渐变，
 * 只认绿色的做法在那些帧上会整片失效。填充跟随的是**局部连续性**：
 * 从画面四边长出去，只吃掉「本身像背景色」且「和相邻背景色接近」的像素，
 * 到角色轮廓的突变处停下。
 *
 * 三条实证约束（照抄自游戏素材大师插件实测，改任何一个都会退回旧 bug）：
 *
 * 1. **调色板只从背景主色簇取**：角色贴到画面边缘（尾巴、头发、裙摆被裁到
 *    边上）时它的颜色也会出现在边框采样里；不筛掉，填充就会顺着同色的
 *    身体部位一路吃进去 —— 实测一张 438×768 帧上，1.6% 的边框采样点是
 *    藏青，默认容差下 7.7% 的掩码变成角色的裙子与头发。
 * 2. **局部容差必须收紧（默认 12）**：它只负责跨过背景自身的噪声与编码块
 *    边界；背景的大范围变化（渐变 / 打光）由全局调色板负责。放宽会顺着
 *    抗锯齿软边缘渗进角色体内 —— 实测 16 开始穿透，18 以上整片失效。
 * 3. **空间掩码只在结果合理时采用**：几乎全背景（画面里没主体）或几乎没
 *    背景（四边就是角色本身）都不可信，此时退回纯颜色判据。
 *
 * 本模块在移植基础上多了两件事：
 *   - 背景色可指定（不只有绿幕）：`chroma: 'green' | 'blue' | 'magenta' | 'auto'`；
 *   - 出**自检报告**：每帧抠掉的背景占比、是否用了空间掩码、边缘残留估计，
 *     用户在「抽帧 → 抠图」之间能立刻看出这批视频是不是能抠。
 *
 * @module src/video-chroma.mjs
 */
import { encodePng } from './video-media.mjs'

export const DEFAULT_KEY_OPTIONS = {
  keyLow: 14,
  keyHigh: 80,
  despill: 0.65,
  edgeShrink: 0,
  bgTolerance: 40,
}

const PALETTE_GRID = 16
const PALETTE_CELL = 256 / PALETTE_GRID
const PALETTE_CELLS = PALETTE_GRID * PALETTE_GRID * PALETTE_GRID

/**
 * 单链聚类的「同一片背景色」阈值：格心距离 ≤ 2 格（= 32）。
 * 相邻（16）、斜一格（22.6）、体对角（27.7）都算连通，于是平缓渐变会一路
 * 串成一簇（这正是要保留的能力），而隔两格以上的跳跃（35.8 起）断开，
 * 角色那种明显不同的颜色因此自成小簇，随后被主簇筛掉。
 */
const CLUSTER_STEP_SQ = (2 * PALETTE_CELL) ** 2
const CLUSTER_NEIGHBORS = (() => {
  const out = []
  for (let dr = -2; dr <= 2; dr += 1) {
    for (let dg = -2; dg <= 2; dg += 1) {
      for (let db = -2; db <= 2; db += 1) {
        if (dr === 0 && dg === 0 && db === 0) continue
        const distSq = (dr * PALETTE_CELL) ** 2 + (dg * PALETTE_CELL) ** 2 + (db * PALETTE_CELL) ** 2
        if (distSq <= CLUSTER_STEP_SQ + 1e-6) out.push([dr, dg, db])
      }
    }
  }
  return out
})()

/** 一个簇至少要占多少边框采样点才配进调色板（角色贴边时那一小撮约 1.6%）。 */
const CLUSTER_MIN_SHARE = 0.15

function colorDistance(rgba, a, b) {
  const dr = rgba[a] - rgba[b]
  const dg = rgba[a + 1] - rgba[b + 1]
  const db = rgba[a + 2] - rgba[b + 2]
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

/** 用四边像素建一个「背景色查找格」（量化到 16 档 / 通道）。 */
function buildBackgroundPalette(rgba, width, height, globalTolerance, chroma) {
  const grid = new Uint8Array(PALETTE_CELLS)
  const samples = []
  const stepX = Math.max(1, Math.floor(width / 128))
  const stepY = Math.max(1, Math.floor(height / 128))
  for (let x = 0; x < width; x += stepX) {
    samples.push(x * 4, ((height - 1) * width + x) * 4)
  }
  for (let y = 0; y < height; y += stepY) {
    samples.push(y * width * 4, (y * width + width - 1) * 4)
  }
  if (samples.length === 0) return { grid, samples: 0, kept: 0, dropped: 0 }

  const cellOf = (offset) => ((rgba[offset] >> 4) << 8) | ((rgba[offset + 1] >> 4) << 4) | (rgba[offset + 2] >> 4)
  const counts = new Uint32Array(PALETTE_CELLS)
  for (const offset of samples) counts[cellOf(offset)] += 1

  // 单链聚类（最多 4096 个格子，代价可忽略）。
  const cluster = new Int32Array(PALETTE_CELLS).fill(-1)
  const clusterSize = []
  for (let seed = 0; seed < PALETTE_CELLS; seed += 1) {
    if (counts[seed] === 0 || cluster[seed] !== -1) continue
    const id = clusterSize.length
    let size = 0
    cluster[seed] = id
    const queue = [seed]
    while (queue.length > 0) {
      const cell = queue.pop()
      size += counts[cell]
      const r = cell >> 8
      const g = (cell >> 4) & 15
      const b = cell & 15
      for (const [dr, dg, db] of CLUSTER_NEIGHBORS) {
        const nr = r + dr
        const ng = g + dg
        const nb = b + db
        if (nr < 0 || nr >= PALETTE_GRID || ng < 0 || ng >= PALETTE_GRID || nb < 0 || nb >= PALETTE_GRID) continue
        const next = (nr << 8) | (ng << 4) | nb
        if (counts[next] === 0 || cluster[next] !== -1) continue
        cluster[next] = id
        queue.push(next)
      }
    }
    clusterSize.push(size)
  }

  let largest = 0
  for (let i = 1; i < clusterSize.length; i += 1) {
    if (clusterSize[i] > clusterSize[largest]) largest = i
  }
  const keepCluster = clusterSize.map((size, id) => id === largest || size / samples.length >= CLUSTER_MIN_SHARE)

  // 量化误差最多 8*sqrt(3) ≈ 14，补进半径里，避免刚好卡在格边界的颜色被漏掉。
  const limit = globalTolerance + 14
  const limitSq = limit * limit
  const radius = Math.max(1, Math.ceil(limit / PALETTE_CELL))
  const seen = new Uint8Array(PALETTE_CELLS)
  let kept = 0
  const mark = (index) => {
    const r = Math.min(PALETTE_GRID - 1, rgba[index] >> 4)
    const g = Math.min(PALETTE_GRID - 1, rgba[index + 1] >> 4)
    const b = Math.min(PALETTE_GRID - 1, rgba[index + 2] >> 4)
    const key = (r * PALETTE_GRID + g) * PALETTE_GRID + b
    if (seen[key] === 1) return
    seen[key] = 1
    // 必须按**球体**标记，不能只扫一个立方体：立方体角落到中心距离可达
    // limit*sqrt(3)，角色那种离背景很远的颜色也会被误判成背景。
    for (let dr = -radius; dr <= radius; dr += 1) {
      const nr = r + dr
      if (nr < 0 || nr >= PALETTE_GRID) continue
      for (let dg = -radius; dg <= radius; dg += 1) {
        const ng = g + dg
        if (ng < 0 || ng >= PALETTE_GRID) continue
        for (let db = -radius; db <= radius; db += 1) {
          const nb = b + db
          if (nb < 0 || nb >= PALETTE_GRID) continue
          const distSq = (dr * PALETTE_CELL) ** 2 + (dg * PALETTE_CELL) ** 2 + (db * PALETTE_CELL) ** 2
          if (distSq > limitSq) continue
          grid[(nr * PALETTE_GRID + ng) * PALETTE_GRID + nb] = 1
        }
      }
    }
  }
  for (const offset of samples) {
    const id = cluster[cellOf(offset)]
    if (id < 0 || keepCluster[id] !== true) continue
    // chroma = 'green' / 'blue' 时额外要求采样点确实带那个色相，把贴边角色的
    // 肤色 / 头发色挡在调色板之外（'auto' 不做这层限制）。
    if (chroma === 'green' && rgba[offset + 1] - Math.max(rgba[offset], rgba[offset + 2]) < 8) continue
    if (chroma === 'blue' && rgba[offset + 2] - Math.max(rgba[offset], rgba[offset + 1]) < 8) continue
    if (chroma === 'magenta' && Math.min(rgba[offset], rgba[offset + 2]) - rgba[offset + 1] < 8) continue
    kept += 1
    mark(offset)
  }
  return { grid, samples: samples.length, kept, dropped: samples.length - kept }
}

function paletteHas(grid, rgba, index) {
  const r = Math.min(PALETTE_GRID - 1, rgba[index] >> 4)
  const g = Math.min(PALETTE_GRID - 1, rgba[index + 1] >> 4)
  const b = Math.min(PALETTE_GRID - 1, rgba[index + 2] >> 4)
  return grid[(r * PALETTE_GRID + g) * PALETTE_GRID + b] === 1
}

/**
 * 从四边洪水填充出背景掩码：必须**同时**满足「颜色像背景（全局调色板）」
 * 和「与相邻的已判定背景像素颜色接近（局部连续性）」。返回 1 = 背景。
 */
export function segmentBackgroundDetailed(rgba, width, height, globalTolerance, localTolerance, chroma = 'auto') {
  const local = Math.max(1, Math.round(localTolerance ?? 12))
  const built = buildBackgroundPalette(rgba, width, height, globalTolerance, chroma)
  const palette = built.grid
  const total = width * height
  const background = new Uint8Array(total)
  const stack = new Int32Array(total)
  let top = 0
  const push = (index) => {
    if (background[index] === 1) return
    if (!paletteHas(palette, rgba, index * 4)) return
    background[index] = 1
    stack[top++] = index
  }
  for (let x = 0; x < width; x += 1) {
    push(x)
    push((height - 1) * width + x)
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width)
    push(y * width + width - 1)
  }
  while (top > 0) {
    const index = stack[--top]
    const current = index * 4
    const x = index % width
    const y = (index - x) / width
    const visit = (n) => {
      if (background[n] === 1) return
      if (!paletteHas(palette, rgba, n * 4)) return
      if (colorDistance(rgba, current, n * 4) > local) return
      background[n] = 1
      stack[top++] = n
    }
    if (x > 0) visit(index - 1)
    if (x < width - 1) visit(index + 1)
    if (y > 0) visit(index - width)
    if (y < height - 1) visit(index + width)
  }
  return { mask: background, samples: built.samples, kept: built.kept, dropped: built.dropped }
}

export const segmentBackground = (rgba, width, height, globalTolerance, localTolerance, chroma) =>
  segmentBackgroundDetailed(rgba, width, height, globalTolerance, localTolerance, chroma).mask

/** 没启用空间分割时，用颜色判据粗略估背景占比，供界面判断可信度。 */
function countChromaBackground(rgba, high, chroma) {
  let count = 0
  for (let p = 0; p < rgba.length; p += 4) {
    if (chromaDominance(rgba, p, chroma) >= high) count += 1
  }
  return count
}

/** 某个像素「有多像背景色」：绿幕看 g-max(r,b)，蓝幕看 b-max(r,g)。 */
function chromaDominance(rgba, p, chroma) {
  const r = rgba[p]
  const g = rgba[p + 1]
  const b = rgba[p + 2]
  if (chroma === 'blue') return b - Math.max(r, g)
  if (chroma === 'magenta') return Math.min(r, b) - g
  return g - Math.max(r, b)
}

/**
 * 抠掉背景，返回新 RGBA 缓冲与诊断信息（输入输出都是非预乘 alpha）。
 *
 * `chroma` 决定「绿色优势值」这一辅助判据看哪个通道；`auto` 会先扫一遍
 * 画面，哪个通道最占优就按哪个处理（这样绿幕、蓝幕都不用用户选）。
 */
export function keyFrame(rgba, width, height, options = {}) {
  const opts = { ...DEFAULT_KEY_OPTIONS, ...options }
  // 'auto' 真的做检测：整帧平均后哪个通道优势最大就按哪个处理。此前
  // 'auto' 无条件落成 'green'，蓝幕/品红幕素材（默认设置就是 auto！）按
  // 绿幕判据抠像 → 背景整片保留（实测：蓝幕帧 corner alpha=255，fraction=0）。
  let chroma = opts.chroma && opts.chroma !== 'auto' ? opts.chroma : null
  if (chroma === null) {
    let sumR = 0
    let sumG = 0
    let sumB = 0
    let count = 0
    for (let p = 0; p < rgba.length; p += 4 * Math.max(1, Math.floor((width * height) / 4096)) * 4) {
      sumR += rgba[p]
      sumG += rgba[p + 1]
      sumB += rgba[p + 2]
      count += 1
    }
    // 退化保险：采样步进异常时兜底为绿（历史行为）
    if (count === 0) chroma = 'green'
    else {
      const meanR = sumR / count
      const meanG = sumG / count
      const meanB = sumB / count
      if (meanB > meanR && meanB > meanG) chroma = 'blue'
      else if (Math.min(meanR, meanB) > meanG) chroma = 'magenta'
      else chroma = 'green'
    }
  }
  const low = Math.max(0, Math.min(255, opts.keyLow))
  const high = Math.max(low + 1, Math.min(255, opts.keyHigh))
  const span = high - low
  const despill = Math.max(0, Math.min(1, opts.despill))
  const tolerance = Math.max(0, opts.bgTolerance ?? 0)
  const pixels = width * height

  // 空间分割只在结果合理时采用：几乎全是背景说明画面里没有主体，
  // 几乎没有背景说明四边就是角色本身（贴边裁切）。两种都不可信。
  let background
  let backgroundCount = 0
  let borderSamples = 0
  let borderSamplesDropped = 0
  if (tolerance > 0) {
    const built = segmentBackgroundDetailed(rgba, width, height, tolerance, 12, chroma)
    borderSamples = built.samples
    borderSamplesDropped = built.dropped
    let count = 0
    for (let i = 0; i < pixels; i += 1) count += built.mask[i]
    const fraction = count / pixels
    if (fraction > 0.12 && fraction < 0.985) {
      background = built.mask
      backgroundCount = count
    }
  }

  const out = Buffer.alloc(rgba.length)
  for (let i = 0; i < pixels; i += 1) {
    const p = i * 4
    const r = rgba[p]
    const g = rgba[p + 1]
    const b = rgba[p + 2]
    const srcAlpha = rgba[p + 3]
    const dominance = chromaDominance(rgba, p, chroma)
    let alpha = 1
    if (dominance >= high) alpha = 0
    else if (dominance > low) alpha = 1 - (dominance - low) / span
    alpha *= srcAlpha / 255
    if (background !== undefined && background[i] === 1) alpha = 0
    // 去溢色（despill）：只压「背景色成分超过其余通道」的那部分，保留合法亮部。
    let outR = r
    let outG = g
    let outB = b
    if (despill > 0) {
      const weight = despill * (1 - alpha)
      if (weight > 0) {
        if (chroma === 'blue') {
          const cap0 = Math.max(r, g)
          if (b > cap0) outB = Math.round(b - (b - cap0) * weight)
        } else if (chroma === 'magenta') {
          const cap0 = g
          if (Math.min(r, b) > cap0) {
            outR = Math.round(r - (r - cap0) * weight)
            outB = Math.round(b - (b - cap0) * weight)
          }
        } else {
          const cap0 = Math.max(r, b)
          if (g > cap0) outG = Math.round(g - (g - cap0) * weight)
        }
      }
    }
    out[p] = outR
    out[p + 1] = outG
    out[p + 2] = outB
    out[p + 3] = Math.round(alpha * 255)
  }

  if (opts.edgeShrink > 0) shrinkAlpha(out, width, height, Math.min(8, Math.round(opts.edgeShrink)))

  const fraction = background !== undefined ? backgroundCount / pixels : countChromaBackground(rgba, high, chroma) / pixels
  return {
    rgba: out,
    backgroundFraction: fraction,
    usedSegmentation: background !== undefined,
    borderSamples,
    borderSamplesDropped,
    chroma,
    // 判据：背景占比落在 25%~92% 之间最可信（太少=主体贴边，太多=几乎空镜）。
    confident: fraction > 0.25 && fraction < 0.92,
  }
}

/** 对 alpha 通道做可分离最小值滤波，等价于把前景边界向内收缩 n 像素。 */
function shrinkAlpha(rgba, width, height, radius) {
  const alpha = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i += 1) alpha[i] = rgba[i * 4 + 3]
  const horizontal = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    for (let x = 0; x < width; x += 1) {
      let min = 255
      const from = Math.max(0, x - radius)
      const to = Math.min(width - 1, x + radius)
      for (let k = from; k <= to; k += 1) {
        const v = alpha[row + k]
        if (v < min) min = v
      }
      horizontal[row + x] = min
    }
  }
  for (let y = 0; y < height; y += 1) {
    const from = Math.max(0, y - radius)
    const to = Math.min(height - 1, y + radius)
    for (let x = 0; x < width; x += 1) {
      let min = 255
      for (let k = from; k <= to; k += 1) {
        const v = horizontal[k * width + x]
        if (v < min) min = v
      }
      rgba[(y * width + x) * 4 + 3] = min
    }
  }
}

/**
 * 所有帧 alpha 包围盒的并集（多帧共用一个框 → 缩放一致、脚底对齐同一基线）。
 *
 * ★ 必须在**抠完的帧**上算，不能在原帧上算。回放这一版代码时踩到过：
 * 原帧整张是不透明的（绿幕也是「不透明像素」），它的包围盒就是整个画面；
 * 拿这个框去对齐模板，等于什么都没裁 —— 主体被缩成一个点，
 * 合成图上只剩几段 2px 的细线。
 *
 * `threshold` 是「算作不透明」的 alpha 下限：绿幕边缘的抗锯齿残影常在
 * 1~8 之间，太低会把框撑大，取 8 是实测的折中。
 */
export function unionBoundingBox(rows, threshold = 8) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const row of rows) {
    for (const frame of row.frames) {
      if (frame.length < row.width * row.height * 4) continue
      for (let y = 0; y < row.height; y += 1) {
        const rowStart = y * row.width * 4
        for (let x = 0; x < row.width; x += 1) {
          if (frame[rowStart + x * 4 + 3] <= threshold) continue
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
  }
  if (minX === Infinity) return { x: 0, y: 0, width: 0, height: 0, empty: true }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, empty: false }
}

/** 单帧的 alpha 包围盒（界面「逐帧裁掉多余透明边」用）。 */
export function frameBoundingBox(rgba, width, height, threshold = 8) {
  return unionBoundingBox([{ frames: [rgba], width, height }], threshold)
}

/** 按 alpha 预乘做盒式平均，避免背景色渗进边缘，再填满输出的一块。 */
function blitBlock(out, outWidth, outHeight, destX, destY, destW, destH, frame, frameWidth, frameHeight, srcX, srcY, srcW, srcH) {
  const x0 = Math.max(0, destX)
  const y0 = Math.max(0, destY)
  const x1 = Math.min(outWidth, destX + destW)
  const y1 = Math.min(outHeight, destY + destH)
  if (x1 <= x0 || y1 <= y0) return
  const sx0 = Math.max(0, Math.floor(srcX))
  const sy0 = Math.max(0, Math.floor(srcY))
  const sx1 = Math.min(frameWidth, Math.ceil(srcX + srcW))
  const sy1 = Math.min(frameHeight, Math.ceil(srcY + srcH))
  if (sx1 <= sx0 || sy1 <= sy0) return
  let sumR = 0
  let sumG = 0
  let sumB = 0
  let sumA = 0
  let count = 0
  for (let y = sy0; y < sy1; y += 1) {
    let index = (y * frameWidth + sx0) * 4
    for (let x = sx0; x < sx1; x += 1, index += 4) {
      const a = frame[index + 3]
      sumR += frame[index] * a
      sumG += frame[index + 1] * a
      sumB += frame[index + 2] * a
      sumA += a
      count += 1
    }
  }
  if (count === 0 || sumA === 0) return
  const r = Math.round(sumR / sumA)
  const g = Math.round(sumG / sumA)
  const b = Math.round(sumB / sumA)
  const a = Math.round(sumA / count)
  for (let y = y0; y < y1; y += 1) {
    let index = (y * outWidth + x0) * 4
    for (let x = x0; x < x1; x += 1, index += 4) {
      out[index] = r
      out[index + 1] = g
      out[index + 2] = b
      out[index + 3] = a
    }
  }
}

/**
 * 把若干行 × 若干帧拼成一张整图（行 = 行，列 = 帧）。
 *
 * 与游戏素材大师的差别：多了 `layout: 'row' | 'grid'` 与 `columns`。
 * 序列帧通常是一行 N 格，但 32/64 帧的行图会宽到超出纹理上限，
 * 那时按 grid 折成多行更实际（Maker 侧的 AnimationSet2D 不挑形状，
 * 只有自己按格子切的时候才需要知道列数）。
 */
export function composeSheet(rows, options) {
  const rowCount = Math.max(1, rows.length)
  const perRow = Math.max(1, options.frameCount)
  const layout = options.layout === 'grid' && options.columns > 0 ? 'grid' : 'row'
  let columns
  if (layout === 'grid') columns = Math.max(1, Math.round(options.columns))
  else columns = rowCount === 1 ? perRow : perRow
  const rowsOut = layout === 'grid' ? Math.ceil((rowCount * perRow) / columns) : rowCount
  const cellWidth = options.cellWidth
  const cellHeight = options.cellHeight
  const width = cellWidth * columns
  const height = cellHeight * rowsOut
  const rgba = Buffer.alloc(width * height * 4)
  const pixelSize = Math.max(1, Math.round(options.pixelSize ?? 1))
  const first = rows.find((row) => row.frames.length > 0)
  const frameWidth = first?.width ?? cellWidth
  const frameHeight = first?.height ?? cellHeight
  const bbox = options.autoCrop
    ? unionBoundingBox(rows)
    : { x: 0, y: 0, width: frameWidth, height: frameHeight, empty: false }
  const emptyContent = { x: 0, y: 0, width: 0, height: 0, scaleX: 0, scaleY: 0 }
  if (bbox.empty || bbox.width <= 0 || bbox.height <= 0) {
    return { rgba, width, height, columns, rows: rowsOut, bbox, content: emptyContent, layout }
  }
  const bottomMargin = Math.max(0, Math.min(cellHeight - 1, Math.round(options.bottomMargin ?? 0)))
  const fill = Math.max(0.1, Math.min(1, options.fillRatio ?? 0.94))
  let scaleX
  let scaleY
  if (options.fitMode === 'stretch') {
    scaleX = cellWidth / bbox.width
    scaleY = (cellHeight - bottomMargin) / bbox.height
  } else {
    const scale = Math.min((cellWidth * fill) / bbox.width, ((cellHeight - bottomMargin) * fill) / bbox.height)
    scaleX = scale
    scaleY = scale
  }
  const contentW = Math.min(cellWidth, Math.max(1, Math.round(bbox.width * scaleX)))
  const contentH = Math.min(cellHeight - bottomMargin, Math.max(1, Math.round(bbox.height * scaleY)))
  const offsetX = Math.round((cellWidth - contentW) / 2)
  // 贴底放置：脚底落在同一条基线上，上下起伏才不会看起来在飘。
  const offsetY = Math.max(0, cellHeight - bottomMargin - contentH)
  const blocksX = Math.ceil(cellWidth / pixelSize)
  const blocksY = Math.ceil(cellHeight / pixelSize)

  let slot = 0
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]
    for (let col = 0; col < perRow; col += 1) {
      const frame = row.frames[col]
      if (frame === undefined || frame.length < frameWidth * frameHeight * 4) {
        slot += 1
        continue
      }
      const gx = layout === 'grid' ? slot % columns : col
      const gy = layout === 'grid' ? Math.floor(slot / columns) : rowIndex
      slot += 1
      const cellOriginX = gx * cellWidth
      const cellOriginY = gy * cellHeight
      for (let by = 0; by < blocksY; by += 1) {
        const relY = by * pixelSize
        if (relY >= contentH) break
        const destY = offsetY + relY
        for (let bx = 0; bx < blocksX; bx += 1) {
          const relX = bx * pixelSize
          if (relX >= contentW) break
          const destX = offsetX + relX
          const clipLeft = Math.max(0, destX)
          const clipTop = Math.max(0, destY)
          const clipRight = Math.min(cellWidth, destX + pixelSize)
          const clipBottom = Math.min(cellHeight, destY + pixelSize)
          if (clipRight <= clipLeft || clipBottom <= clipTop) continue
          if (clipRight <= offsetX || clipLeft >= offsetX + contentW) continue
          if (clipBottom <= offsetY || clipTop >= offsetY + contentH) continue
          blitBlock(
            rgba, width, height,
            cellOriginX + clipLeft, cellOriginY + clipTop, clipRight - clipLeft, clipBottom - clipTop,
            frame, frameWidth, frameHeight,
            bbox.x + (clipLeft - offsetX) / scaleX,
            bbox.y + (clipTop - offsetY) / scaleY,
            (clipRight - clipLeft) / scaleX,
            (clipBottom - clipTop) / scaleY,
          )
        }
      }
    }
  }
  return {
    rgba, width, height, columns, rows: rowsOut, bbox,
    content: { x: offsetX, y: offsetY, width: contentW, height: contentH, scaleX, scaleY },
    layout,
  }
}

/** 把一串同尺寸帧横向拼成一条预览带（只给界面看）。 */
export function makeStrip(frames, cellWidth, cellHeight) {
  const width = cellWidth * frames.length
  const rgba = Buffer.alloc(width * cellHeight * 4)
  const cellBytes = cellWidth * cellHeight * 4
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i]
    if (frame.length < cellBytes) continue
    for (let y = 0; y < cellHeight; y += 1) {
      const srcStart = y * cellWidth * 4
      const destStart = (y * width + i * cellWidth) * 4
      frame.copy(rgba, destStart, srcStart, srcStart + cellWidth * 4)
    }
  }
  return encodePng(rgba, width, cellHeight)
}

export const keyedPng = (rgba, width, height) => encodePng(rgba, width, height)
