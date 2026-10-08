// 开发用校验脚本：语法检查所有 JS、校验 manifest、PAC 语法与服务注册表。
// 用法：node tools/check.js
import { readFileSync, readdirSync, statSync, mkdtempSync, copyFileSync, unlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];

// ---------- 1. 语法检查所有 .js（ESM 文件复制为 .mjs 后检查） ----------
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', 'icons', 'test'].includes(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const tmp = mkdtempSync(join(tmpdir(), 'itr-check-'));
const jsFiles = walk(root);
for (const file of jsFiles) {
  const rel = file.slice(root.length + 1);
  try {
    const isModule = /(^|\\|\/)(shared|background)\\|(^|\\|\/)(shared|background)\//.test(rel);
    if (isModule) {
      const target = join(tmp, rel.replace(/[\\/]/g, '_') + '.mjs');
      copyFileSync(file, target);
      execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
      unlinkSync(target);
    } else {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    }
    console.log(`  ok  ${rel}`);
  } catch (e) {
    errors.push(`${rel} 语法错误: ${e.stderr || e.message}`);
  }
}
rmSync(tmp, { recursive: true, force: true });

// ---------- 2. manifest 校验 ----------
try {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const required = ['manifest_version', 'name', 'version', 'background', 'content_scripts', 'action'];
  for (const key of required) {
    if (!(key in manifest)) errors.push(`manifest.json 缺少字段: ${key}`);
  }
  if (manifest.manifest_version !== 3) errors.push('manifest_version 应为 3');
  // 引用文件存在性
  const refs = [];
  for (const size of Object.keys(manifest.icons || {})) refs.push(manifest.icons[size]);
  refs.push(manifest.action.default_popup);
  refs.push(manifest.options_page);
  refs.push(manifest.background.service_worker);
  for (const cs of manifest.content_scripts) {
    refs.push(...(cs.js || []), ...(cs.css || []));
  }
  for (const ref of refs) {
    try {
      statSync(join(root, ref));
    } catch {
      errors.push(`manifest 引用的文件不存在: ${ref}`);
    }
  }
  console.log('  ok  manifest.json 结构与引用文件');
} catch (e) {
  errors.push('manifest.json 解析失败: ' + e.message);
}

// ---------- 3. HTML 引用的本地资源存在性 ----------
const htmlFiles = [];
function walkHtml(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git'].includes(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkHtml(p, out);
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}
for (const html of walkHtml(root)) {
  const text = readFileSync(html, 'utf8');
  const re = /(?:src|href)="([^"#]+)"/g;
  let m;
  while ((m = re.exec(text))) {
    const ref = m[1];
    if (/^(https?:|data:|#|mailto:)/.test(ref)) continue;
    try {
      statSync(join(dirname(html), decodeURIComponent(ref.split('?')[0])));
    } catch {
      errors.push(`${html.slice(root.length + 1)} 引用不存在: ${ref}`);
    }
  }
}
console.log('  ok  HTML 资源引用');

// ---------- 5. PAC 脚本生成与语法校验 ----------
// 测试固件：两套 AI 方案，供 PAC 与设置合并测试共用
const AI_PROFILES = [
  { id: 'pA', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-a', model: 'deepseek-chat', apiFormat: 'openai', temperature: 0.2, prompt: '' },
  { id: 'pB', name: 'Claude', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-b', model: 'claude-sonnet-4-5', apiFormat: 'claude', temperature: 0.2, prompt: '' }
];

const proxyUrl = pathToFileURL(join(root, 'background', 'proxy.js'));
const { buildPacScript } = await import(proxyUrl.href);
const pacScenarios = [
  { name: '旧版单配置', settings: { ai: { baseUrl: 'https://api.deepseek.com' } }, proxy: 'PROXY 127.0.0.1:7890', expect: ['api.deepseek.com'] },
  { name: '无 AI 配置', settings: { ai: {} }, proxy: 'SOCKS5 127.0.0.1:1080', expect: [] },
  { name: '非法地址', settings: { ai: { baseUrl: 'not-a-valid-url' } }, proxy: 'PROXY p:1', expect: [] },
  // 回归：v1.4.0 多方案重构后，自定义 AI 接口必须仍然进入 PAC（曾读已废弃的 settings.ai.baseUrl）
  { name: '多方案', settings: { ai: { activeId: 'pA', profiles: AI_PROFILES } }, proxy: 'PROXY 127.0.0.1:7890', expect: ['api.deepseek.com', 'api.anthropic.com'] }
];
for (const sc of pacScenarios) {
  const pac = buildPacScript(sc.settings, sc.proxy);
  try {
    new Function(pac); // 语法校验
    if (!pac.includes('FindProxyForURL')) throw new Error('缺少 FindProxyForURL');
    const missing = sc.expect.filter((h) => !pac.includes(`"${h}":1`));
    if (missing.length) throw new Error(`未包含主机名: ${missing.join(', ')}`);
    console.log(`  ok  PAC 脚本生成（${sc.name}）`);
  } catch (e) {
    errors.push(`PAC 脚本错误（${sc.name}）: ${e.message}`);
  }
}

// ---------- 6. 翻译服务注册表完整性 ----------
const providersModule = await import(pathToFileURL(join(root, 'background', 'providers.js')).href);
for (const name of ['google', 'ai']) {
  if (!providersModule.PROVIDERS[name] || typeof providersModule.PROVIDERS[name].translate !== 'function') {
    errors.push(`PROVIDERS.${name} 未注册或缺少 translate`);
  } else {
    console.log(`  ok  PROVIDERS.${name} 注册完整`);
  }
}
// 已下线的免费通道：百度（v1.3 移除）、微软必应（v1.5.2 移除，免费鉴权端点已全球 404）
for (const gone of ['baidu', 'microsoft']) {
  if (providersModule.PROVIDERS[gone]) {
    errors.push(`PROVIDERS.${gone} 应已移除（该免费通道已下线）`);
  } else {
    console.log(`  ok  ${gone} 已移除`);
  }
}
if ('microsoft' in providersModule.CHUNK_LIMITS) {
  errors.push('CHUNK_LIMITS.microsoft 应已移除');
} else {
  console.log('  ok  CHUNK_LIMITS 无 microsoft');
}

// ---------- 7. 默认设置结构 ----------
const defaultsModule = await import(pathToFileURL(join(root, 'shared', 'defaults.js')).href);
const d = defaultsModule.DEFAULT_SETTINGS;
if (!d.ai || !('activeId' in d.ai) || !Array.isArray(d.ai.profiles) || !('style' in d.ai)) {
  errors.push('DEFAULT_SETTINGS.ai 缺少 activeId / profiles / style 字段');
} else {
  console.log('  ok  DEFAULT_SETTINGS.ai 结构（activeId / profiles / style）');
}
if ('baidu' in d) {
  errors.push('DEFAULT_SETTINGS.baidu 应已移除');
} else {
  console.log('  ok  DEFAULT_SETTINGS 无 baidu 配置');
}
if (!Array.isArray(d.autoTranslateSites)) {
  errors.push('DEFAULT_SETTINGS 缺少 autoTranslateSites');
} else {
  console.log('  ok  DEFAULT_SETTINGS.autoTranslateSites 存在');
}

// ---------- 8. AI 方案迁移逻辑 ----------
const swModule = await import(pathToFileURL(join(root, 'background', 'service-worker.js')).href).catch(() => null);
if (swModule) {
  errors.push('service-worker 不应可在 Node 中直接导入（顶层 chrome 依赖）');
} else {
  console.log('  ok  service-worker 保持浏览器环境专用');
}
// 用正则粗验迁移代码存在（避免真正执行带 chrome 依赖的模块）
{
  const swSrc = readFileSync(join(root, 'background', 'service-worker.js'), 'utf8');
  if (!swSrc.includes('itrUsage2')) {
    errors.push('service-worker 缺少新版按服务分类的用量存储');
  } else {
    console.log('  ok  用量统计按服务分桶（itrUsage2）');
  }
  if (!swSrc.includes('二分重试')) {
    errors.push('service-worker 缺少二分对齐重试');
  } else {
    console.log('  ok  批次对不齐时二分重试');
  }
  if (swSrc.includes('KEYLESS_FALLBACK')) {
    errors.push('service-worker 不应再有 KEYLESS_FALLBACK（免费接口互备已随微软通道一并移除）');
  } else {
    console.log('  ok  免费接口互备（KEYLESS_FALLBACK）已移除');
  }
  const proxySrc = readFileSync(join(root, 'background', 'proxy.js'), 'utf8');
  if (/microsoft/i.test(proxySrc)) {
    errors.push('proxy.js 仍引用 microsoft 域名');
  } else {
    console.log('  ok  PAC 代理范围不含 microsoft 域名');
  }
}

// ---------- 9. 设置合并 / 迁移 / 代理范围回归测试 ----------
// shared/settings.js 是纯函数模块，可直接导入做行为断言（不依赖 chrome）。
const { mergeDefaults, applyPartial, aiProfileBaseUrls } = await import(
  pathToFileURL(join(root, 'shared', 'settings.js')).href
);

// (a) 翻译风格必须原样保留
// 回归：曾用 apiFormat 的取值（openai/claude）校验 style，条件恒为真，
// 导致 academic / tech 每次读取设置都被重置为 general，风格功能完全失效。
{
  const bad = [];
  for (const style of ['general', 'academic', 'tech']) {
    const s = mergeDefaults({ ai: { activeId: 'pA', style, profiles: AI_PROFILES } });
    if (s.ai.style !== style) bad.push(`${style}→${s.ai.style}`);
  }
  if (bad.length) errors.push('翻译风格未被保留: ' + bad.join(', '));
  else console.log('  ok  翻译风格取值保留（general / academic / tech）');
}

// (b) 部分更新不得清空已保存的 AI 方案与 API Key
// 回归：弹窗切换方案时只提交 { ai: { activeId } }，浅合并会整体替换 ai 对象，
// 导致 profiles 丢失并被旧版迁移逻辑重建为空方案。
{
  const before = mergeDefaults({ ai: { activeId: 'pA', style: 'academic', profiles: AI_PROFILES } });
  const after = applyPartial(before, { ai: { activeId: 'pB' } });
  const problems = [];
  if (after.ai.profiles.length !== 2) problems.push(`方案数变为 ${after.ai.profiles.length}（应为 2）`);
  if (after.ai.activeId !== 'pB') problems.push(`activeId 为 ${after.ai.activeId}（应为 pB）`);
  if (after.ai.style !== 'academic') problems.push(`风格变为 ${after.ai.style}（应保留 academic）`);
  if (!after.ai.profiles.some((p) => p.apiKey === 'sk-b')) problems.push('方案的 API Key 丢失');
  if (problems.length) errors.push('部分更新破坏了 AI 方案：' + problems.join('；'));
  else console.log('  ok  部分更新保留 AI 方案与 API Key');
}

// (c) 旧版单配置迁移为多方案
{
  const m = mergeDefaults({ ai: { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-old', model: 'deepseek-chat', apiFormat: 'openai' } });
  if (m.ai.profiles.length !== 1 || m.ai.profiles[0].apiKey !== 'sk-old' || m.ai.activeId !== 'profile-legacy') {
    errors.push('旧版单 AI 配置迁移失败');
  } else {
    console.log('  ok  旧版单 AI 配置迁移为多方案');
  }
}

// (d) 所有 AI 方案地址都要纳入代理范围（弹窗可随时切换方案）
{
  const urls = aiProfileBaseUrls({ ai: { activeId: 'pA', profiles: AI_PROFILES } });
  if (!urls.includes('https://api.deepseek.com') || !urls.includes('https://api.anthropic.com')) {
    errors.push('aiProfileBaseUrls 未覆盖全部 AI 方案地址');
  } else {
    console.log('  ok  全部 AI 方案地址纳入代理范围');
  }
}

// (e) 异常 / 旧版输入安全兜底，不得抛错
{
  try {
    mergeDefaults(null);
    mergeDefaults(undefined);
    mergeDefaults({ ai: null });
    mergeDefaults({ ai: { profiles: 'x' } });
    mergeDefaults({ provider: 'baidu' });
    console.log('  ok  异常/旧版设置输入安全兜底');
  } catch (e) {
    errors.push('mergeDefaults 处理异常输入时抛错: ' + e.message);
  }
}

// (f) 已下线的免费服务必须迁移到 google
// 微软必应的免费鉴权端点（edge.microsoft.com/translate/auth）已全球返回 404，
// 老用户存储里的 provider=microsoft / baidu 必须回落到谷歌，否则翻译会直接失败。
{
  const problems = [];
  for (const legacy of ['baidu', 'microsoft']) {
    const s = mergeDefaults({ provider: legacy });
    if (s.provider !== 'google') problems.push(`${legacy}→${s.provider}`);
  }
  if (mergeDefaults({}).provider !== 'google') problems.push('默认值不是 google');
  if (problems.length) errors.push('已下线服务未迁移到 google: ' + problems.join(', '));
  else console.log('  ok  已下线免费服务（baidu / microsoft）迁移到 google');
}

// ---------- 结果 ----------
console.log('');
if (errors.length) {
  console.error(`✗ 发现 ${errors.length} 个错误:`);
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
} else {
  console.log('✓ 全部检查通过');
}
