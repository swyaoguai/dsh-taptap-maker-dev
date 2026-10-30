---
name: taptap-maker-free-assets
description: 优先检索指定的六个游戏素材来源，逐项核验零成本、原作者授权、商用/修改/游戏分发和依赖权利，严格区分可复用资产与截图灵感，避免盲目生图。
whenToUse: 用户需要免费游戏素材、UI套件、图标、精灵、音频、素材来源检索或授权核验时；在考虑生成新素材之前使用。
user-invocable: true
---

# 免费游戏素材检索与证据门禁

## 核心原则

**优先来源是检索偏好，不是许可证白名单。免费浏览/免费登录/免费下载 ≠ 免费商用；CC0/MIT 标识 ≠ 原作者或第三方权利已经核实。**

先复用项目中已经有可追溯授权的素材，再检索下列来源，之后才考虑用户明确要求的其他方案。用户没要求生成时，不为补素材自动生图；不付费回退、不消耗 Maker 生成额度、不登录/加账号、不安装工具、不更改模型或生成通道的顺序/开关。

来源、单项素材授权、网站自动访问权限是三件独立的事。纯数据函数 `assessFreeAssetCandidate` 只评估已记录的证据是否完整，**不联网、不下载，不证明记录真实，也不提供法律保证或抓取许可**。

## 六个优先来源（按用户给定顺序）

研究日期：2026-10-30。下列六个输入地址当次均返回 HTTP 200；没有登录、获取素材包或核验所有外链/未来页面。`game-ui-kits` 使用 ASCII 连字符，不使用不换行连字符。

| 来源入口 | 类型与正确用途 | 单项访问/政策证据 | 自动访问 |
| --- | --- | --- | --- |
| [GameUI](https://gameui.net/) | 设计师作品集、游戏 UI 截图和风格参考；默认参考，不是可直接切图的资产库。 | [作品集样本](https://www.gameui.net/works/15066)没有核实可复用授权；没有在已检查页面找到站点级商用/修改条款。不能由此断言站内永远不存在个别明确授权资源。 | 未核实；不得把 unknown 视作允许抓取。 |
| [Interface In Game](https://interfaceingame.com/) | 游戏截图/视频 UI 灵感；只提供索引链接和一般布局观察，不导入截图。偶尔出现的资源文章需另查原作者授权。 | [条款](https://interfaceingame.com/terms-and-conditions/)保留经营者和第三方权利，游戏/图片归各自权利人；[版权投诉规则](https://interfaceingame.com/copyright-complaints/)。 | **禁止 spider/crawl/scrape**。仅查搜索引擎元数据/给用户手动浏览链接；不使用 Firecrawl、web_fetch、自动浏览器或下载器继续抓取本站。 |
| [enotsixlm Game UI Kits](https://enotsixlm.github.io/game-ui-kits/) | 七套 HTML/CSS 组件代码，可参考或在单项许可通过后提取代码；不是 PNG 套件或直接可执行的 Maker Lua UI。 | [官方仓库](https://github.com/enotsixlm/game-ui-kits)及 [README](https://raw.githubusercontent.com/enotsixlm/game-ui-kits/main/README.md)声明 MIT；检查的根目录没有独立完整 LICENSE，不能编造版权声明。 | 未核实；MIT 代码权限不等于网站抓取权限。 |
| [LemoUI](https://lemooui.com/) / [资源目录](https://www.lemooui.com/resource) | 作品集、动效参考与资源商城混合；默认学习参考/另行授权。 | [版权说明](https://www.lemooui.com/about/12)要求商用取得原权利人授权，素材供学习交流；[服务协议](https://www.lemooui.com/about/13)默认非商业用途；[PSD 样本](https://www.lemooui.com/resource/show/id/1159)需 100积分并禁止直接使用/转载。 | 未核实；不登录、赚积分或解锁下载来绕过门禁。 |
| [Pixlab24](https://pixlab24.com/) | 网络用户收集上传的素材聚合目录；用于发现线索，再寻找原作者发布页。 | [免费标记样本](https://pixlab24.com/icons/1386/)未核实原作者/完整许可；[VIP](https://pixlab24.com/vip-prices)下载权益不等于零成本。部分条目如 [Darinia](https://pixlab24.com/tilesets/font/24822/)确实复述商用/修改条款，但原始授权和完整附带许可仍未核实。 | 未核实；优先取得经过核验的原始来源，不默认从镜像入库。 |
| [用户给定 Kenney /games](https://kenney.nl/games) | 有效的游戏目录，但不是资产授权入口。素材搜索用 [Kenney /assets](https://kenney.nl/assets)；[UI 筛选](https://kenney.nl/assets/tag:interface)是站点导航链接，仍需当次核实。 | [UI Pack 单项页](https://kenney.nl/assets/ui-pack)明确 CC0/可不捐赠免费下载；[官方支持](https://kenney.nl/support)的 CC0/可商用声明仅针对资产页游戏素材，署名可选、工作室 logo 保留。 | 未核实；免费许可不表示已取得自动抓取许可。 |

**搜索入口不是下载对象。** `searchUrl/referenceUrl` 用于发现；`candidateAccessLinks` 是单项核验入口，而且可能是 restricted/reference-only/uncleared 样本，不能一律当作待下载资产。保持 Kenney 的 `suppliedUrl=/games` 与 `searchUrl=/assets` 分离。

## 实际检索流程

1. 明确用途、风格、格式、尺寸、是否需要源文件、商用和改色/裁切/动画/游戏内分发方式；不为无关素材整站收集。
2. 查看已有素材的来源与授权记录；“在项目里”也不是权利证明。
3. 使用已具备的只读搜索工具，在六个优先来源中按类型查索引元数据，例如 `site:gameui.net 像素 UI`、`site:interfaceingame.com inventory`、`site:kenney.nl/assets interface`。优先集合保持顺序，**许可门禁优先于来源顺序**；参考站可提供灵感链接，但不能拿截图补图标。
4. 自动访问状态为 forbidden 时停止目标站抓取；unknown 时不自动启动抓取/爬虫。可提供公开元数据与人工访问链接，或先核实条款/robots/授权。不要安装工具、规避登录/验证码或请求用户密码。
5. 对实际候选记录下面的逐项证据。聚合目录只提供线索：找到原作者、原始版本和原许可；找不到就 hold，不用转载方的“免费/可商用”几个字代替授权。
6. 返回简洁候选表：名称、预览/原作者页、单项访问页、许可证、零成本证据、商用/修改/嵌入/分发范围、署名/通知、依赖/IP/来源检查、allow/hold/reject 和具体原因。不要声称代码已经证明合法。
7. 没有通过候选就如实说“尚无核实可用的免费素材”，保留参考链接；不偷偷降级成 NC/ND、付费、截图或付费生成。不宣扬加账号、轮询绕过额度或调整生成通道。

## 逐项证据门禁

缺失/未知/未经核实 → **hold**。明确付费/VIP、NC、ND、禁止拟议用途、盗取/ripped、已知争议 → **reject**。只有以下内容都明确记录并满足，才可将记录标为 **allow/eligible**：

- 精确名称、文件/套件版本、作者/权利人、原发布页和单项素材访问页；完整授予范围与该版本对应。
- 明确数值零成本及价格/访问证据，不强制购买、付费订阅/VIP或积分解锁；“VIP 内免费下载”“royalty-free”不是充分证据。
- 权利人/有授权原发布方的许可证或明确许可，以及相应全文；标准 MIT/CC0/OFL 文本和网站首页本身不能证明这份素材由谁授权。
- 明确允许商业使用、修改、游戏内嵌入和按拟议方式随游戏分发；区分随游戏使用与独立转卖/再分发素材包，遵守不同限制。
- 署名、版权通知、许可证文本、修改标记/保留名称等义务已经满足，记录证据与发布位置；不能拿署名抵消缺失授权。
- 所有字体、emoji 渲染图、音频、纹理、图片、角色、logo/商标、肖像等依赖逐项核查，来源链和冲突/盗取检查完成。空依赖列表仅表示审查后确认不存在外部依赖，不是默认清白。
- 优先核实 CC0；CC-BY、MIT 代码、OFL 字体只有在相应义务满足时才用。自定义、share-alike/copyleft 等许可需要额外人工复核，不能为避开判断而改写许可证。

没有任何许可证能保证未来绝无争议；[CC0 官方文本](https://creativecommons.org/publicdomain/zero/1.0/legalcode.en)本身不替你清除其他人的权利、不授权商标/专利，并有免责声明。站点描述不继承成单项 `license` 或 `free` 标志。

### MIT 代码 / 字体 / 图片分别处理

- [MIT](https://opensource.org/license/mit)允许复制、修改、商业分发，但复制实质代码时须保留版权和许可通知。enotsixlm 的 README 声明不代表其中第三方品牌、插图或字体已经统一许可；缺失的作者/通知不得自行填造。
- [实际像素组件代码](https://raw.githubusercontent.com/enotsixlm/game-ui-kits/main/pixel-ui-kit.html)使用 Press Start 2P **和 VT323**；仅看入口页列的一种字体不够。其 [Press Start 2P](https://raw.githubusercontent.com/google/fonts/main/ofl/pressstart2p/OFL.txt) / [VT323](https://raw.githubusercontent.com/google/fonts/main/ofl/vt323/OFL.txt)许可是 OFL-1.1；其他组件的字体仍要单独核验。[Google Fonts FAQ](https://developers.google.com/fonts/faq)说明字体条件依许可证而异。
- OFL 字体文件/衍生字体可以随商业游戏嵌入，但要保留字体版权/许可，不得单独售卖字体；有 Reserved Font Name 的修改字体按条件改名。OFL 不要求普通文字输出图片或文档变成 OFL 字体文件；但 OS/vendor emoji 图形也不能由 MIT 自动取得权利。
- 来源仅供参考时只借鉴通用信息层级、留白、交互模式；不下载截图、切片、描摹受保护图形、复制特征角色/标识，或把版权截图带入项目/生成参考链。
- 单项许可通过且自动访问另有权限时，只提取获准的具体代码/文件；不整站抓取、批量镜像或把不许可依赖打包。将 HTML/CSS 适配为 Maker 的实现仍需相应通知与依赖检查，不宣称原文件直接就是 Lua UI。

## 证据记录结构（待查模板，不可照抄为“已核实”）

```json
{
  "sourceId": "kenney",
  "assetName": null,
  "assetUrl": null,
  "creator": null,
  "version": null,
  "kind": null,
  "checkedAt": null,
  "cost": { "amount": null, "verified": false, "evidenceUrl": null },
  "original": { "url": null, "evidenceUrl": null, "authoritative": false },
  "license": {
    "id": null, "termsUrl": null, "evidenceUrl": null,
    "authoritative": false, "scopeVerified": false,
    "commercial": null, "modification": null,
    "gameEmbedding": null, "gameRedistribution": null,
    "noticesSatisfied": false, "noticeEvidence": null,
    "obligationsSatisfied": false
  },
  "checks": {
    "dependencies": false, "ip": false, "provenance": false,
    "ripped": null, "disputed": null
  },
  "dependencies": []
}
```

`sourceId` 只是发现来源，不是版权拥有者；在 GameUI/Pixlab 发现后到外部原作者页取得许可，仍需真实原来源证据。每个已声明依赖使用同样的完整记录结构。非预审常见许可需 `license.additionalReviewSatisfied=true`；OFL-1.1 字体文件另需 `fontCompliance={licensePreserved:true, standaloneSale:false, reservedNamesSatisfied:true}`，这些值均须真实核验，不能由站点名自动填充。

同时保留原作者、精确版本、许可全文/引用、证据页摘录、访问成本、适用范围、核验日期和未知项。后续若用户明确要求获取/导入且门禁通过，才在 `assets/` 之外暂存获准原文件，保留许可与处理历史/校验值；最终文件另走引擎导入/视觉验收。资源 UUID/.meta 用 Maker 官方生成器，绝不编造；不因素材检索自动构建、提交或推送，不覆盖/删除既有素材。
