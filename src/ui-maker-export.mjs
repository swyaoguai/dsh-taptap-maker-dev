/** Independent Maker static emitter and append-only review staging.
 * This module never modifies, initializes, runs, imports or submits a game. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { assertUiDocument } from './ui-document.mjs'
import { readUiWorkspace, safeUiPath, writeUiFileExclusive, UiWorkflowError } from './ui-workflow.mjs'
import { AUDITED_MAKER_CONTRACT, AUDITED_MAKER_FILES, makerFontOptions, makerNodeBlockers, makerPathInside, planMakerExport, readMakerAssetSet } from './ui-maker-contract.mjs'
export { AUDITED_MAKER_CONTRACT, AUDITED_MAKER_FILES, planMakerExport } from './ui-maker-contract.mjs'

const asJson = value => JSON.stringify(value, null, 2) + '\n'
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const fail = (code, message, details) => { throw new UiWorkflowError(code, message, details) }
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const COMMON = ['backgroundColor', 'borderColor', 'borderWidth', 'borderRadius', 'opacity', 'visible']
function refuseMakerAncestor(directory) {
  let current = path.resolve(directory)
  while (true) {
    // Presence-only guard: do not read configs (or secrets) from an unselected
    // project. Selecting another target never authorizes writes into this one.
    if (fs.existsSync(path.join(current, '.project', 'project.json')) && fs.existsSync(path.join(current, 'assets'))) fail('MAKER_STAGE_INSIDE_PROJECT', '插件侧静态审阅不能写入任何 Maker 工程，包括未选作目标的工程。')
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}
function resourcePath(resource) {
  return typeof resource === 'string' && resource.length <= 1024 && resource.startsWith('ui/') && !/[\u0000-\u001f\u007f\\:]/.test(resource) && resource.split('/').every(part => part && part !== '.' && part !== '..') && /\.(png|jpe?g|webp)$/i.test(resource)
}
export function compileMakerUi(document, options = {}) {
  assertUiDocument(document)
  const fonts = makerFontOptions(options, { assetPaths: true })
  const blockers = [...fonts.blockers, ...makerNodeBlockers(document)]
  if (blockers.length) fail(blockers[0].code, blockers[0].message, { blockers })
  const mapped = new Map()
  for (const node of document.nodes) {
    const props = node.props
    const native = {
      type: node.type === 'label' ? 'Label' : node.type === 'button' ? 'Button' : 'Panel',
      id: node.id, width: node.layout.width, height: node.layout.height,
      position: node.parent === null ? 'relative' : 'absolute',
      left: node.layout.x, top: node.layout.y,
      // Explicit neutral defaults stop the source theme from silently adding
      // padding/border/radius to the authored fixed-coordinate content.
      padding: 0, margin: 0, borderWidth: 0, borderRadius: 0,
      backgroundColor: '#00000000', borderColor: '#00000000',
      visible: true, opacity: 1,
      pointerEvents: props.enabled === false ? 'none' : (node.type === 'button' ? 'auto' : 'box-none'),
      children: [],
    }
    for (const property of COMMON) if (props[property] !== undefined) native[property] = props[property]
    if (node.type === 'label' || node.type === 'button') {
      native.text = props.text ?? ''
      native.fontSize = (props.fontSize ?? AUDITED_MAKER_CONTRACT.font.defaultIRSizePx) / ((96 / 72) * fonts.fontScale)
      native.fontWeight = props.fontWeight ?? 'normal'
      if (node.type === 'label') {
        native.fontColor = props.color ?? '#FFFFFF'
        native.textAlign = props.align ?? 'left'
        native.verticalAlign = 'middle'
      } else {
        native.textColor = props.color ?? '#FFFFFF'
        native.paddingHorizontal = 0
        native.disabled = props.enabled === false
      }
    }
    if (node.type === 'image') {
      const resource = options.assetPaths?.[props.asset]
      if (resource === undefined) fail('MAKER_ASSET_PATH_REQUIRED', `图片 ${node.id} 需要明确的素材资源路径。`)
      if (!resourcePath(resource)) fail('MAKER_ASSET_PATH_UNSAFE', '图片资源必须是安全的 assets-root 相对 ui/ 路径。')
      native.backgroundImage = resource
      native.backgroundFit = props.imageFit === 'stretch' ? 'fill' : (props.imageFit ?? 'contain')
      if (props.imageFit === 'sliced') native.backgroundSlice = [...props.slice]
    }
    mapped.set(node.id, native)
  }
  let root
  for (const node of document.nodes) {
    if (node.parent === null) root = mapped.get(node.id)
    else mapped.get(node.parent).children.push(mapped.get(node.id))
  }
  return root
}

// Lua is not JSON. Three-digit decimal escapes remain unambiguous even when
// followed by an ASCII digit, and cover every ASCII control byte (incl. NUL).
function luaString(value) {
  if (typeof value !== 'string' || !value.isWellFormed()) fail('MAKER_LUA_STRING_INVALID', 'Lua 文本必须是有效 Unicode 字符串。')
  let result = '"'
  for (const character of value) {
    const code = character.codePointAt(0)
    if (character === '"') result += '\\"'
    else if (character === '\\') result += '\\\\'
    else if (code < 32 || code === 127) result += '\\' + String(code).padStart(3, '0')
    else result += character
  }
  return result + '"'
}
function luaValue(value) {
  if (typeof value === 'string') return luaString(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isFinite(value)) {
    const literal = String(value)
    // IR numbers have JavaScript IEEE-double semantics, not Lua int64 wrap.
    return /^[+-]?\d+$/.test(literal) ? literal + '.0' : literal
  }
  if (Array.isArray(value)) return '{' + value.map(luaValue).join(', ') + '}'
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => `[${luaString(key)}] = ${luaValue(item)}`).join(', ') + '}'
  fail('MAKER_LUA_SCALAR_INVALID', 'Lua 绑定只允许已验证的有限标量和声明式数据。')
}

export function createMakerBindings(document) {
  assertUiDocument(document)
  const model = {
    root: document.nodes.find(node => node.parent === null).id,
    nodes: document.nodes.map(node => ({ id: node.id, parent: node.parent ?? false, type: node.type, enabled: node.props.enabled !== false, visible: node.props.visible !== false })),
    state: document.state, keys: Object.keys(document.state),
    actions: document.actions, events: document.events, bindings: document.bindings,
  }
  return `-- Independent generated UI binder. Pure finite declarations only.
-- Source-pinned APIs; nativeVerified=false. No game entry or global root ownership.
local UI = require("urhox-libs/UI")
local M = {}
local model = ${luaValue(model)}
local sessions = setmetatable({}, { __mode = "k" })
local specById, actionById = {}, {}
for _, spec in ipairs(model.nodes) do specById[spec.id] = spec end
for _, action in ipairs(model.actions) do actionById[action.id] = action end

local function finite(value)
    return type(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge
end
local function scalar(value)
    return type(value) == "string" or type(value) == "boolean" or finite(value)
end
local function scalarText(value)
    if type(value) == "number" and finite(value) and math.abs(value) < 1e21 and math.floor(value) == value then
        return string.format("%.0f", value)
    end
    return tostring(value)
end
local function conditionMatches(condition, state)
    if not condition then return true end
    local value, other = rawget(state, condition.key), condition.value
    if condition.op == "eq" then return value == other end
    if condition.op == "ne" then return value ~= other end
    if not finite(value) or not finite(other) then return false end
    if condition.op == "gte" then return value >= other end
    if condition.op == "gt" then return value > other end
    if condition.op == "lte" then return value <= other end
    if condition.op == "lt" then return value < other end
    return false
end
local function insideNode(id, ancestor)
    while id do
        if id == ancestor then return true end
        local spec = specById[id]
        id = spec and spec.parent or false
    end
    return false
end

function M.Bind(instance, state, options)
    assert(type(instance) == "table" and type(instance.GetRoot) == "function" and type(instance.Find) == "function", "UI.LoadJSON Instance with GetRoot/Find is required")
    if sessions[instance] then return sessions[instance] end
    -- Capture the weak loader root before allocating options/state tables.
    local root = instance:GetRoot()
    assert(root, "loaded UI instance has no root")
    assert(state == nil or type(state) == "table", "state must be a declared scalar table")
    options = options or {}
    assert(type(options) == "table", "options must be a table")
    assert(options.onToast == nil or type(options.onToast) == "function", "onToast must be a host callback")
    assert(options.Attach == nil or type(options.Attach) == "function", "Attach must be an explicit host callback")
    local widgets, authoredDisabled = {}, {}
    -- Resolve and validate every owned widget before subscribing any handlers.
    for _, spec in ipairs(model.nodes) do
        local widget = instance:Find(spec.id)
        assert(widget and type(widget.SetVisible) == "function", "missing owned widget: " .. spec.id)
        widgets[spec.id] = widget
        if spec.type == "button" then
            assert(type(widget.SetDisabled) == "function" and type(widget.OnEvent) == "function" and type(widget.OffEvent) == "function", "Button requires audited event/disabled API")
            authoredDisabled[spec.id] = not spec.enabled or (type(widget.IsDisabled) == "function" and widget:IsDisabled() == true)
        end
    end
    for _, binding in ipairs(model.bindings) do assert(type(widgets[binding.node].SetText) == "function", "text binding requires SetText") end
    state = state or {}
    local initial = {}
    for _, key in ipairs(model.keys) do
        local value = rawget(state, key)
        if value == nil then value = model.state[key] end
        assert(scalar(value), "non-scalar or non-finite state: " .. key)
        initial[key] = type(value) == "number" and (value + 0.0) or value
    end
    for _, key in ipairs(model.keys) do state[key] = initial[key] end
    -- Hold a strong root reference: audited UILoader Instance root/id maps are weak.
    local api = { instance = instance, root = root, state = state, lastToast = nil }
    local subscriptions, disposed, activeModal = {}, false, nil
    local blocked = {}
    local function isVisible(id)
        local widget = widgets[id]
        if type(widget.IsVisible) == "function" then return widget:IsVisible() ~= false end
        return widget.props and widget.props.visible ~= false
    end
    local function contextVisible(id)
        while id do
            if not isVisible(id) then return false end
            id = specById[id].parent
        end
        return true
    end
    local function contextEnabled(id)
        while id do
            if not specById[id].enabled then return false end
            id = specById[id].parent
        end
        return true
    end
    local function refreshInteraction()
        activeModal = nil
        for _, spec in ipairs(model.nodes) do
            if spec.type == "modal" and contextVisible(spec.id) then activeModal = spec.id end
        end
        for _, spec in ipairs(model.nodes) do
            if spec.type == "button" then
                blocked[spec.id] = authoredDisabled[spec.id] or not contextVisible(spec.id) or not contextEnabled(spec.id) or (activeModal ~= nil and not insideNode(spec.id, activeModal))
                widgets[spec.id]:SetDisabled(blocked[spec.id] == true)
            end
        end
    end
    local function toast(text)
        api.lastToast = text
        if options.onToast then options.onToast(text, api) end
    end
    function api:Refresh()
        if disposed then return nil, "UI bindings disposed" end
        for _, key in ipairs(model.keys) do
            if not scalar(rawget(state, key)) then return nil, "non-scalar or non-finite state: " .. key end
        end
        for _, binding in ipairs(model.bindings) do
            local text = binding.template:gsub("{([A-Za-z][A-Za-z0-9_-]*)}", function(key) return scalarText(rawget(state, key)) end)
            widgets[binding.node]:SetText(text)
        end
        refreshInteraction()
        return true
    end
    function api:Dispatch(actionId)
        if disposed then return nil, "UI bindings disposed" end
        local action = actionById[actionId]
        if not action then return nil, "unknown declared action" end
        local nextState = {}
        for _, key in ipairs(model.keys) do
            local value = rawget(state, key)
            if not scalar(value) then return nil, "non-scalar or non-finite state: " .. key end
            nextState[key] = type(value) == "number" and (value + 0.0) or value
        end
        if not conditionMatches(action.when, nextState) then
            if action.otherwiseToast then toast(action.otherwiseToast) end
            self:Refresh()
            return true, "condition-false"
        end
        -- Validate finite updates before committing state or UI visibility.
        for _, step in ipairs(action.steps) do
            if step.type == "set" then nextState[step.key] = step.value
            elseif step.type == "increment" then
                if not finite(nextState[step.key]) or not finite(step.value) then return nil, "increment requires finite numbers" end
                local nextValue = nextState[step.key] + step.value
                if not finite(nextValue) then return nil, "non-finite state update" end
                nextState[step.key] = nextValue
            end
        end
        for _, key in ipairs(model.keys) do state[key] = nextState[key] end
        for _, step in ipairs(action.steps) do
            if step.type == "show" then widgets[step.node]:SetVisible(true)
            elseif step.type == "hide" then widgets[step.node]:SetVisible(false)
            elseif step.type == "toggle" then widgets[step.node]:SetVisible(not isVisible(step.node))
            elseif step.type == "toast" then toast(step.text)
            end
        end
        return self:Refresh()
    end
    function api:Dispose()
        if disposed then return false end
        disposed = true
        for _, subscription in ipairs(subscriptions) do
            pcall(function() subscription.widget:OffEvent("click", subscription.handler) end)
        end
        -- Restore only this instance's captured author-disabled baselines.
        for id, disabled in pairs(authoredDisabled) do pcall(function() widgets[id]:SetDisabled(disabled) end) end
        sessions[instance] = nil
        subscriptions = {}
        self.instance, self.root = nil, nil
        return true
    end
    local ok, bindingError = pcall(function()
        for _, event in ipairs(model.events) do
            local nodeId, actionId = event.node, event.action
            local widget = widgets[nodeId]
            local handler = function()
                if disposed then return end
                refreshInteraction()
                if not blocked[nodeId] then api:Dispatch(actionId) end
            end
            -- Record our exact handler first, including partially failing attaches.
            subscriptions[#subscriptions + 1] = { widget = widget, handler = handler }
            widget:OnEvent("click", handler)
        end
        assert(api:Refresh())
    end)
    if not ok then api:Dispose(); error(bindingError) end
    sessions[instance] = api
    return api
end

function M.Load(resourceId, state, options)
    if type(resourceId) ~= "string" or resourceId == "" then return nil, "resourceId is required" end
    local ok, instance, loadError = pcall(UI.LoadJSON, resourceId)
    if not ok then return nil, tostring(instance) end
    if not instance then return nil, tostring(loadError or "UI.LoadJSON returned nil") end
    local bound, api = pcall(M.Bind, instance, state, options)
    if not bound then return nil, tostring(api) end
    if options and options.Attach then
        local attached, attachError = pcall(options.Attach, api.root, instance, api)
        if not attached then api:Dispose(); return nil, tostring(attachError) end
    end
    return api
end
function M.Dispatch(instance, actionId)
    local api = sessions[instance]
    if not api then return nil, "instance is not bound" end
    return api:Dispatch(actionId)
end
function M.Dispose(instance)
    local api = sessions[instance]
    return api and api:Dispose() or false
end
return M
`
}

function hostExample(resourceId, binderModule, fonts) {
  return `-- REVIEW EXAMPLE ONLY. Not an entry script and never auto-installed.
-- Reconcile this with the host's actual font, scale, safe-area and event ownership.
local UI = require("urhox-libs/UI")
local Binder = require(${luaString(binderModule)})
local Host = {}

-- Invoke only for the FIRST initialization. Existing UI is not reinitialized.
-- The host owns exactly one input/update/render forwarding path; no subscriptions here.
function Host.FirstInitialization()
    if UI.GetNVGContext() then return nil, "UI already initialized; inspect its font contract instead" end
    UI.Init({ fontSizeMethod = ${luaString(fonts.fontSizeMethod)}, scale = function() return graphics:GetDPR() end, autoEvents = false })
    UI.Theme.SetFontScale(${luaValue(fonts.fontScale)})
    return true
end

-- existingContainer belongs to the host (possibly its ALREADY-padded safe-area view).
-- Choose host-managed insets OR the real UI.SafeAreaView constructor, never both.
-- Example constructor, only when deliberately needed by the host:
-- UI.SafeAreaView({ width = "100%", height = "100%", edges = "all", mode = "padding" })
function Host.AttachTo(existingContainer, state, onToast)
    assert(existingContainer and type(existingContainer.AddChild) == "function", "explicit host container is required")
    return Binder.Load(${luaString(resourceId)}, state, {
        Attach = function(root) existingContainer:AddChild(root) end,
        onToast = onToast,
    })
end
-- Keep the returned controller/instance alive; call controller:Dispose() before
-- removing the host-owned tree. Dispose unsubscribes only its own callbacks.
-- No SetRoot, old-root destruction, global input/render hooks, or UUID literals.
return Host
`
}
function usageMarkdown({ workspaceId, revisionId, resourceId, fonts }) {
  return `# Maker 静态 UI 审阅包\n\n` +
    `状态：**stagedOnly=true，nativeVerified=false，尚未安装到游戏**。浏览器/静态检查/Lua mock 均不能代替原生试玩与截图验收。\n\n` +
    `## 文件与建议落点（仅建议，不自动执行）\n\n` +
    `- main.ui.json → assets/${resourceId}\n` +
    `- images/ → assets/ui/${workspaceId}/${revisionId}/images/\n` +
    `- bindings.lua → scripts/ui/${workspaceId}/${revisionId}/bindings.lua（相对宿主真实 scriptsPath 再确认）\n` +
    `- host-example.lua 是独立示例，不替换 main.lua，也不自动修改任何入口或配置。\n` +
    `- NOTICE-*.txt 须随相应资源保留，manifest.json 保存来源与检查边界。\n\n` +
    `只有取得用户另一次明确安装授权后，才考虑将文件放入已选工程。这个 API 不提供导入命令，不覆盖旧资产，不调用构建/提交/推送。\n\n` +
    `## 接入边界\n\n` +
    `原生树只含 Panel/Label/Button 的平铺属性。Image 是背景图 Panel；List 是固定内容 Panel；Modal 是自定义覆盖 Panel，不是 native Modal、焦点锁定或宿主全局遮罩。\n\n` +
    `UI.LoadJSON(${JSON.stringify(resourceId)}) 返回 Instance；使用 instance:GetRoot()/instance:Find(id)。Bind 幂等；点击由 OnEvent("click", handler) 注册，Dispose 只用 OffEvent("click", 同一handler) 解绑自己并恢复自己按钮的作者 disabled 基线，不销毁或替换宿主树。\n\n` +
    `声明的 set/increment/show/hide/toggle/toast 与有限条件留在独立 Lua。刷新使用 SetText、SetVisible、SetDisabled；toast 通过宿主 onToast 回调，未提供时只记录 lastToast。外部变更 state 后调用 controller:Refresh()。重复 Bind 同一实例返回原 controller，不偷偷换 state/options。\n\n` +
    `fontSizeMethod=${fonts.fontSizeMethod}、fontScale=${fonts.fontScale}；IR 单位 px，导出 pt = px / ((96/72) * fontScale)。首版 char 阻断。宿主真实 UI.Init 需使用所选方法；真实字体倍率由 UI.Theme.SetFontScale 设置，不是无效的 Init.fontScale 参数。此设置仅可由宿主首次初始化例子展示，现有初始化不被修改。\n\n` +
    `缩放、安全区、字体授权/索引、文字度量和唯一输入/更新/渲染转发由宿主负责。不要重复 padding，不使用不存在的 SafeAreaView.Wrap，不设置旧根 destroyOld=true。Load 默认不挂根；Attach 回调由宿主明确传入。\n\n` +
    `## 资源元数据仍待处理\n\n` +
    `本包不生成 UUID/.meta。未来获得安装授权、资源实际进入 assets 后，显式调用官方 generate_resource_meta；完整资源后缀对应 main.ui.json.meta，图片也生成各自完整同名 .meta，已有有效元数据由官方工具保留。不得手造 UUID、搬用别的工程 meta 或将 metadata pending 写成成功。\n\n` +
    `## 未验证与后续验收\n\n` +
    `已做：明确配置/方向、11源码 SHA256、IR/资源路径/大小/文件签名/许可记录、独占新文件、可用时纯 Lua 语法与 mock 行为。许可记录需由资产提供者事先核验，工具不进行下载或在线法律判定；图片签名不等于完整解码或视觉可用。\n\n` +
    `未做：选定游戏入口迁移、真机/引擎加载、原生字体/布局/光照画面、触控/安全区、视觉试玩录像、广告/联网与运行期资源索引。必须在另获明确原生运行授权后再执行 asset-visual-qa；不把能编译/日志无错当作已验收。\n`
}

export function createMakerReview(root, workspaceId, revisionId, projectDirectory, options = {}) {
  if (typeof revisionId !== 'string' || !SAFE_ID.test(revisionId)) fail('UI_PATH', '审阅导出需要明确的不可变 revision ID；不能自动选最新修订。')
  // This verifies committed revision bytes. Ignore any directory-like fields
  // in stored metadata; derive the physical workspace from validated arguments.
  const saved = readUiWorkspace(root, workspaceId, revisionId)
  const workspaceDirectory = safeUiPath(root, workspaceId)
  const plan = planMakerExport(saved.document, projectDirectory, options)
  if (!plan.ready) fail('MAKER_EXPORT_BLOCKED', '静态审阅导出前置检查未通过；未写入游戏或审阅目录。', plan)
  if (makerPathInside(plan.projectDirectory, workspaceDirectory)) fail('MAKER_STAGE_INSIDE_PROJECT', '本任务只完成插件侧：审阅包不能位于目标游戏工程内。')
  refuseMakerAncestor(workspaceDirectory)
  const assetSet = readMakerAssetSet(saved.document, options.assetRoot, { workspaceDirectory, includeBytes: true })
  if (assetSet.blockers.length) {
    const issue = assetSet.blockers[0]
    fail(issue.code, issue.message, { blockers: assetSet.blockers })
  }
  const fonts = makerFontOptions(options)
  const resourceBase = `ui/${workspaceId}/${revisionId}`
  const resourceId = `${resourceBase}/main.ui.json`
  const binderModule = `ui/${workspaceId}/${revisionId}/bindings`
  const assetPaths = Object.fromEntries(assetSet.assets.map(asset => [asset.id, `${resourceBase}/images/${asset.id}${asset.extension}`]))
  // Prepare everything before reserving a directory; never write partial data
  // into a chosen game target, and never reuse/overwrite an earlier review.
  const payloads = [
    { path: 'main.ui.json', data: asJson(compileMakerUi(saved.document, { fontSizeMethod: fonts.fontSizeMethod, fontScale: fonts.fontScale, assetPaths })) },
    { path: 'bindings.lua', data: createMakerBindings(saved.document) },
    { path: 'host-example.lua', data: hostExample(resourceId, binderModule, fonts) },
    { path: 'usage.md', data: usageMarkdown({ workspaceId, revisionId, resourceId, fonts }) },
  ]
  for (const asset of assetSet.assets) {
    payloads.push({ path: `images/${asset.id}${asset.extension}`, data: asset.data, license: asset.license })
    if (asset.noticeText !== null) payloads.push({ path: `NOTICE-${asset.id}.txt`, data: asset.noticeText.endsWith('\n') ? asset.noticeText : asset.noticeText + '\n', license: asset.license })
  }
  const exportId = 'review-' + new Date().toISOString().replace(/[-:.Z]/g, '') + '-' + crypto.randomBytes(6).toString('hex')
  const directory = safeUiPath(workspaceDirectory, `exports/${exportId}`)
  if (makerPathInside(plan.projectDirectory, directory)) fail('MAKER_STAGE_INSIDE_PROJECT', '静态审阅目录不能写入目标工程。')
  const exportsDirectory = safeUiPath(workspaceDirectory, 'exports')
  fs.mkdirSync(exportsDirectory, { recursive: true })
  fs.mkdirSync(directory) // Exclusive reservation. A collision is not retried/overwritten.
  const manifest = {
    format: 'taptap-maker-ui-review', version: 1, exportId,
    status: 'staged', stagedOnly: true, nativeVerified: false,
    workspaceId, revisionId, documentSha256: saved.sha256,
    projectDirectory: plan.projectDirectory, targetAccess: 'read-only',
    orientation: plan.orientation, design: { ...saved.document.design },
    options: { fontSizeMethod: fonts.fontSizeMethod, fontScale: fonts.fontScale },
    sourceContract: AUDITED_MAKER_CONTRACT, sourceFiles: plan.sourceFiles,
    warnings: plan.warnings, metadata: { ...AUDITED_MAKER_CONTRACT.metadata },
    resourceId,
    installation: { main: `assets/${resourceId}`, images: `assets/${resourceBase}/images/`, bindings: `scripts/${binderModule}.lua`, requiresSeparateUserApproval: true, automated: false },
    files: payloads.map(payload => ({ path: payload.path, sha256: digest(payload.data), size: Buffer.byteLength(payload.data), ...(payload.license ? { license: payload.license } : {}) })),
  }
  const files = payloads.map(payload => writeUiFileExclusive(workspaceDirectory, `exports/${exportId}/${payload.path}`, payload.data))
  // Commit manifest LAST. Failed attempts remain isolated/incomplete; no deletion.
  files.push(writeUiFileExclusive(workspaceDirectory, `exports/${exportId}/manifest.json`, asJson(manifest)))
  return {
    ok: true, status: 'staged', stagedOnly: true, nativeVerified: false,
    exportId, workspaceId, revisionId, projectDirectory: plan.projectDirectory,
    options: manifest.options, orientation: plan.orientation, directory, files,
    resourceId, metadata: { ...AUDITED_MAKER_CONTRACT.metadata }, plan,
  }
}
