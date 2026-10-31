/**
 * Historical LGUI model adaptation, SPDX-License-Identifier: MIT.
 * Source: LumioGames/LGUI e962aa3617aaad5a2fd5ddf2c80ace4bb1551240
 * Original path: plugin/tools/lib/generate/model.mjs
 * Original SHA256: 3342f16e41ff6f4e6b7f625a5633496d12558f030bbdb3f8f4b7b365f69c2dfd
 * Changes: remove unaudited parser dependency; inject validated XML and line
 * readers. Package/model/reference/page algorithms otherwise kept. A separate
 * original wrapper enforces filesystem, budget and feature boundaries.
 * This is NOT Unity/Maker runtime reuse or full FairyGUI compatibility.
 *
 * MIT License
 * 
 * Copyright (c) 2026 LumioGames
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import fs from 'node:fs';
import path from 'node:path';
import { LgCliError } from '../third_party/LGUI-MIT/plugin/tools/lib/errors.mjs';

// 引用里的扩展类型 → 控件类型名（和接口层 UIKinds 一致）。
const extensionKinds = {Button: 'button', ProgressBar: 'progress', Label: 'label', Slider: 'slider', ComboBox: 'combobox'};
const tagKinds = {image: 'image', text: 'text', richtext: 'richtext', inputtext: 'input', graph: 'graph', loader: 'loader', list: 'list', tree: 'tree', movieclip: 'movieclip'};

// 解析 controller 的 pages="页ID,页名,页ID,页名…"。
export function parsePages(pages = '') {
  const parts = pages.split(',');
  const result = [];
  for (let i = 0; i + 1 < parts.length; i += 2) result.push({id: parts[i], name: parts[i + 1]});
  return result;
}

// 读整个 ui/：fairyPath 是 ui/UI.fairy。
export function readUiModel(fairyPath, { readXml, findLine } = {}) {
  if (typeof readXml !== 'function' || typeof findLine !== 'function') throw new LgCliError('UI_IMPORT_CONTEXT', '模型只允许使用预检后的 XML/来源行回调。');
  const assets = path.join(path.dirname(fairyPath), 'assets');
  const projectRoot = path.dirname(path.dirname(fairyPath));
  const packages = [];
  const byId = new Map();
  for (const dirName of fs.existsSync(assets) ? fs.readdirSync(assets).sort() : []) {
    const descriptor = path.join(assets, dirName, 'package.xml');
    if (!fs.existsSync(descriptor)) continue;
    const {root} = readXml(descriptor, projectRoot);
    const pkg = {id: root.attrs.id, name: dirName, dir: path.join(assets, dirName), file: descriptor, line: 1, resources: [], components: []};
    const resources = root.children.find(child => child.tag === 'resources')?.children ?? [];
    for (const resource of resources) {
      const fileName = resource.attrs.name ?? '';
      const relPath = (resource.attrs.path ?? '/').replace(/^\/+/, '');
      pkg.resources.push({
        id: resource.attrs.id, type: resource.tag, fileName, path: resource.attrs.path ?? '/',
        name: fileName.replace(/\.[^.]+$/, ''), exported: resource.attrs.exported === 'true',
        file: path.join(pkg.dir, relPath, fileName), attrs: resource.attrs, line: undefined, descriptor
      });
    }
    packages.push(pkg);
    byId.set(pkg.id, pkg);
  }
  // 组件：读每个组件 XML。
  for (const pkg of packages) {
    for (const resource of pkg.resources.filter(item => item.type === 'component')) {
      if (!fs.existsSync(resource.file)) continue;
      const {root} = readXml(resource.file, projectRoot);
      const displayList = root.children.find(child => child.tag === 'displayList')?.children ?? [];
      const extension = root.attrs.extention ?? root.attrs.extension ?? null;
      // 按钮的模式（Common / Check / Radio）：只有 Check、Radio 能保持选中，列表的选中项靠它显示。
      const buttonMode = extension === 'Button' ? (root.children.find(child => child.tag === 'Button')?.attrs.mode ?? 'Common') : null;
      // 滑动条是不是只取整数（用户拖动时取整）。
      const wholeNumbers = extension === 'Slider' ? root.children.find(child => child.tag === 'Slider')?.attrs.wholeNumbers === 'true' : null;
      pkg.components.push({
        pkg, resource, id: resource.id, name: resource.name, fullName: `${pkg.name}/${resource.name}`,
        exported: resource.exported, file: resource.file, size: root.attrs.size ?? '0,0', extension, buttonMode, wholeNumbers,
        controllers: root.children.filter(child => child.tag === 'controller').map(child => ({name: child.attrs.name, pages: parsePages(child.attrs.pages), selected: Number(child.attrs.selected ?? 0), line: findLine(resource.file, `name="${child.attrs.name}"`)})),
        transitions: root.children.filter(child => child.tag === 'transition').map(child => child.attrs.name),
        children: displayList.map(node => ({...node, name: node.attrs.name, id: node.attrs.id})),
        root
      });
    }
  }
  const model = {fairyPath, packages, byId};
  // 子组件引用：给每个 component 子控件找到它引用的组件，并定下控件类型。
  for (const pkg of packages) {
    for (const component of pkg.components) {
      for (const child of component.children) {
        child.ref = ['component', 'list', 'tree'].includes(child.tag) ? resolveRef(model, pkg, child) : null;
        child.kind = kindOf(child);
      }
    }
  }
  return model;
}


// 组件实例的 src（同包资源 ID）+ pkg（跨包时的包 ID），或列表的 defaultItem（ui://包ID资源ID）。
function resolveRef(model, pkg, child) {
  let pkgId = child.attrs.pkg ?? pkg.id;
  let resId = child.attrs.src;
  if (child.tag === 'list' || child.tag === 'tree') {
    const url = child.attrs.defaultItem ?? '';
    if (!url.startsWith('ui://') || url.length < 'ui://'.length + 9) return null;
    pkgId = url.slice(5, url.length - 8);
    resId = url.slice(-8);
  }
  const target = model.byId.get(pkgId);
  return target?.components.find(component => component.id === resId) ?? null;
}

function kindOf(child) {
  if (child.tag === 'list' && child.attrs.treeView === 'true') return 'tree';
  if (tagKinds[child.tag]) return tagKinds[child.tag];
  if (child.tag === 'component') return extensionKinds[child.ref?.extension] ?? 'component';
  return null; // group 等不进类型
}

export function findComponent(model, fullName) {
  const [pkgName, compName] = fullName.split('/');
  return model.packages.find(pkg => pkg.name === pkgName)?.components.find(component => component.name === compName) ?? null;
}
