import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {inflateRawSync} from 'node:zlib';

const DIMENSIONS = ['场景', '人群', '可复用', '主题'];
const MAX_TAG = 12;
const clip = (text, n) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

/* ---------------- 最小 ZIP 读取（仅解压，不写 ZIP） ---------------- */

function findEOCD(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw Error('未找到 ZIP 中央目录');
}

function readCentralDirectory(buf) {
  let p = findEOCD(buf);
  const count = buf.readUInt16LE(p + 10);
  p = buf.readUInt32LE(p + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw Error('ZIP 中央目录格式无效');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({name, method, compSize, localOffset});
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buf, entry) {
  const p = entry.localOffset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw Error('ZIP 本地文件头无效');
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRawSync(data,{maxOutputLength:20*1024*1024});
  throw Error('暂不支持该 ZIP 压缩方式：' + entry.method);
}

function decodeEntities(s) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function xmlToText(buf) {
  let s = buf.toString('utf8');
  s = s.replace(/<\/w:p>/g, '\n').replace(/<\/a:p>/g, '\n').replace(/<\/row>/g, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s.replace(/[ \t]+/g, ' ').replace(/\n\s*/g, '\n').replace(/^\s+|\s+$/g, '');
}

/** 从 Office Open XML（docx/pptx/xlsx）中提取可读文本，失败抛错由调用方降级 */
export function extractOfficeText(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const entries = readCentralDirectory(buf);
  const wanted = entries.filter(e =>
    e.name === 'word/document.xml' ||
    /^ppt\/slides\/slide\d+\.xml$/.test(e.name) ||
    e.name === 'xl/sharedStrings.xml' ||
    /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name));
  if (!wanted.length) throw Error('ZIP 中没有可识别的 Office 文本部件');
  const parts = wanted.map(e => xmlToText(readZipEntry(buf, e))).filter(Boolean);
  const text = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw Error('Office 文本部件为空');
  return text.slice(0, 12000);
}

/* ---------------- 内容分级提取 ---------------- */

export async function extractSource(file, folder) {
  const name = file.name;
  if (/\.(txt|md|csv)$/i.test(name) && file.size <= 200000) {
    return {level: 'A', text: (await readFile(join(folder, file.id))).toString('utf8').slice(0, 12000)};
  }
  if (/\.(docx|pptx|xlsx)$/i.test(name)) {
    try {
      const buffer = await readFile(join(folder, file.id));
      return {level: 'B', text: extractOfficeText(buffer)};
    } catch (e) {
      return {level: 'C', text: '', extractError: clip(e.message, 80)};
    }
  }
  return {level: 'C', text: ''};
}

/* ---------------- 规则引擎 ---------------- */

const RULE_TABLE = [
  {labels: ['场景:课前准备'], words: ['备课', '课前', '准备资料', '预习', '讲义']},
  {labels: ['场景:课上讲授'], words: ['课件', 'ppt', '讲授', '课堂', '上课', '授课', 'slide']},
  {labels: ['场景:复盘方法'], words: ['复盘', '改进', '总结', '回顾']},
  {labels: ['场景:过程留档'], words: ['照片', '留档', '现场', '合影']},
  {labels: ['场景:培训组织'], words: ['培训', '岗前', '入职', '训练营', '组织流程']},
  {labels: ['人群:新教师'], words: ['新教师', '新老师', '新手', '岗前', '入职']},
  {labels: ['人群:公益学员'], words: ['公益', '学员', '社区']},
  {labels: ['人群:企业客户'], words: ['企业', '客户', '团队']},
  {labels: ['人群:管理者'], words: ['管理者', '主管', '负责人', '带团队']},
  {labels: ['人群:家长'], words: ['家长', '亲子', '妈妈', '爸爸', '孩子']},
  {labels: ['可复用:课程模板'], words: ['模板', '课件', '课程设计', '大纲']},
  {labels: ['可复用:话术清单'], words: ['话术', '沟通', '清单']},
  {labels: ['可复用:检查清单'], words: ['检查', '核对', 'checklist']},
  {labels: ['可复用:工具表格'], words: ['表格', 'excel', 'xlsx', '工作表']},
  {labels: ['可复用:案例库'], words: ['案例', '示例']},
  {labels: ['可复用:方法文档'], words: ['方法', '方法论', '制度']},
  {labels: ['主题:时间管理'], words: ['时间管理', '日程', '效率']},
  {labels: ['主题:沟通技巧'], words: ['沟通', '表达', '倾听']},
  {labels: ['主题:亲子沟通'], words: ['亲子', '家长', '孩子']},
  {labels: ['主题:职业发展'], words: ['职业', '求职', '晋升', '转型']},
  {labels: ['主题:心理成长'], words: ['心理', '焦虑', '情绪', '压力']},
  {labels: ['主题:项目管理'], words: ['项目', '流程', '管理']},
];

function defaultTags(file) {
  const ext = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  const out = [];
  if (['.pptx', '.ppt'].includes(ext)) out.push('场景:课上讲授');
  if (ext === '.docx') out.push('场景:培训组织');
  if (['.xlsx', '.xls'].includes(ext)) out.push('可复用:工具表格');
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) out.push('场景:过程留档');
  if (ext === '.pdf') out.push('场景:培训组织');
  if (['.txt', '.md', '.csv'].includes(ext)) out.push('可复用:方法文档');
  if (file.category === '学员产出') out.push('人群:公益学员');
  if (file.category === '方法文档') out.push('可复用:方法文档');
  if (file.category === '照片记录') out.push('场景:过程留档');
  if (file.category === '课程资料') out.push('场景:课上讲授');
  return [...new Set(out)];
}

function ruleTag(file, material) {
  const lower = material.toLowerCase();
  const labels = [];
  for (const rule of RULE_TABLE) {
    if (rule.words.some(w => lower.includes(w.toLowerCase()))) labels.push(...rule.labels);
  }
  for (const t of defaultTags(file)) labels.push(t);
  const unique = [...new Set(labels)];
  const fallback = ['场景:培训组织', '主题:项目管理', '可复用:方法文档'];
  let i = 0;
  while (unique.length < 3 && i < fallback.length) {
    if (!unique.includes(fallback[i])) unique.push(fallback[i]);
    i++;
  }
  const linkedName = file.sessionName || file.knowledgeName || '';
  const baseName = file.name.replace(/\.[^.]+$/, '');
  return {
    summary: clip([file.category, linkedName, baseName].filter(Boolean).join(' '), 40),
    tags: unique.slice(0, 8).map(label => ({label, source: 'rule'})),
    engine: 'rule',
  };
}

/* ---------------- 外部 AI 模型 ---------------- */

function buildAiUrl(endpoint) {
  if (endpoint.endsWith('/chat/completions')) return endpoint;
  return endpoint.replace(/\/+$/, '') + '/chat/completions';
}

function stripJsonFence(s) {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return m ? m[1] : s;
}

function normalizeAiResult(json, fallback) {
  const summary = clip(typeof json.summary === 'string' ? json.summary : '', 40);
  if (!Array.isArray(json.tags)) throw Error('模型未返回标签数组');
  const labels = json.tags.map(item => {
    if (typeof item === 'string') return item.trim();
    const label = String(item.label || '').trim();
    const dim = String(item.dimension || '').trim();
    if (label && DIMENSIONS.some(d => label.startsWith(d + ':'))) return label;
    if (label && DIMENSIONS.includes(dim)) return dim + ':' + label;
    return label;
  }).filter(Boolean).map(t => clip(t, 16)).filter(t => DIMENSIONS.some(d => t.startsWith(d + ':')));
  const unique = [...new Set(labels)];
  if (!summary || unique.length < 3) throw Error('模型结果缺少摘要或四维度标签');
  return {summary, tags: unique.slice(0, 8).map(label => ({label, source: 'ai'})), engine: 'ai'};
}

async function callAiTag(file, material) {
  const endpoint = undefined;
  if (!endpoint) throw Error('未配置 AI_ASSET_API');
  const url = buildAiUrl(endpoint);
  const prompt = [
    '你是企业课程管理系统的资料分析助手。请从用户提供的资料文本与元数据中提取：',
    '1) summary：不超过 40 字的一句话中心内容；',
    '2) tags：3—8 个标签，必须使用四个维度前缀：场景:、人群:、可复用:、主题:；',
    '只依据给定材料，不要编造；严格返回 JSON：{"summary":"...","tags":[{"label":"维度:标签","dimension":"维度"}]}。',
  ].join('\n');
  const payload = {
    model: process.env.AI_ASSET_MODEL || 'gpt-4o-mini',
    messages: [
      {role: 'system', content: prompt},
      {role: 'user', content: material.slice(0, 12000)},
    ],
    temperature: 0.2,
    response_format: {type: 'json_object'},
  };
  const headers = {'Content-Type': 'application/json'};
  if (process.env.AI_ASSET_KEY) headers.Authorization = 'Bearer ' + process.env.AI_ASSET_KEY;
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000)});
      if (!res.ok) throw Error('模型接口返回 ' + res.status);
      const json = await res.json();
      const content = json.choices?.[0]?.message?.content;
      if (!content) throw Error('模型响应缺少 choices');
      return normalizeAiResult(JSON.parse(stripJsonFence(content)), null);
    } catch (e) {
      lastError = clip(e.message, 80);
    }
  }
  throw Error(lastError || '模型调用失败');
}

/* ---------------- 对外主流程 ---------------- */

export function parseTags(value) {
  try {
    const list = JSON.parse(value || '[]');
    if (!Array.isArray(list)) return [];
    return list.filter(t => t && typeof t.label === 'string').map(t => ({
      label: clip(t.label, 16),
      source: t.source === 'manual' ? 'manual' : t.source === 'ai' ? 'ai' : 'rule',
    }));
  } catch {
    return [];
  }
}

export async function tagFile({file, folder, data}) {
  const source = await extractSource(file, folder);
  const sessionName = file.session ? data.sessions.find(s => s.id === file.session)?.name : '';
  const knowledgeName = file.knowledge ? data.knowledge.find(k => k.id === file.knowledge)?.name : '';
  const enriched = {...file, sessionName, knowledgeName};
  const meta = [file.name, file.notes, file.category, sessionName, knowledgeName].filter(Boolean).join('\n');
  const material = (meta + (source.text ? '\n' + source.text : '')).slice(0, 14000);
  let result;
  if (false) {
    try {
      result = await callAiTag(enriched, material);
    } catch (e) {
      result = ruleTag(enriched, material);
      result.note = '外部模型暂不可用，已使用规则引擎：' + clip(e.message, 60);
    }
  } else {
    result = ruleTag(enriched, material);
  }
  return {...result, level: source.level, extractError: source.extractError || ''};
}

export function normalizeManualLabel(raw) {
  const label = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!label) throw Error('请填写标签名称');
  if (label.length > 16) throw Error('单个标签不超过 16 个字符');
  if (/[\x00-\x1f]/.test(label)) throw Error('标签包含无效字符');
  return label;
}

export function patchManualTags(current, {add, remove}) {
  const tags = current.slice();
  if (add) {
    const label = normalizeManualLabel(add);
    if (!tags.some(t => t.label === label)) {
      if (tags.length >= MAX_TAG) throw Error('单个文件最多 12 个标签');
      tags.push({label, source: 'manual'});
    }
  }
  if (remove) {
    const label = String(remove).trim();
    const idx = tags.findIndex(t => t.label === label);
    if (idx >= 0) tags.splice(idx, 1);
  }
  return tags;
}

/* ---------------- 语义查询 ---------------- */

const LOCAL_SEMANTIC = [
  {words: ['新老师', '新教师', '新手老师', '新员工'], terms: ['岗前', '新手', '授课技巧', '课堂组织', '培训']},
  {words: ['上课', '讲课', '授课'], terms: ['讲授', '课堂', '授课技巧', '课上']},
  {words: ['入职'], terms: ['岗前', '入职', '培训组织', '新手']},
  {words: ['亲子', '家长'], terms: ['亲子沟通', '家长', '孩子', '家庭']},
  {words: ['时间', '效率'], terms: ['时间管理', '日程', '效率']},
  {words: ['费用', '价格', '成本'], terms: ['价格', '成本', '预算']},
  {words: ['复盘'], terms: ['复盘', '总结', '改进']},
  {words: ['模板'], terms: ['课程模板', '大纲', '模板']},
];
const semanticCache = new Map();

function localTerms(q) {
  const terms = [];
  for (const rule of LOCAL_SEMANTIC) {
    if (rule.words.some(w => q.includes(w))) terms.push(...rule.terms);
  }
  return [...new Set(terms)];
}

export async function semanticQuery({q, allLabels, categories}) {
  const query = clip(q, 60);
  if (!query) return {terms: [], engine: 'rule', aiAvailable: false};
  const cached = semanticCache.get(query);
  if (cached && cached.until > Date.now()) return cached.value;
  const endpoint = process.env.AI_ASSET_API;
  let value;
  if (endpoint) {
    try {
      const url = buildAiUrl(endpoint);
      const prompt = `用户在企业课程资料中心搜索“${query}”。现有标签：${allLabels.join('、')}；资料分类：${categories.join('、')}。请输出 3—8 个中文近义或相关检索词，严格返回 JSON：{"terms":["..."]}`;
      const payload = {
        model: process.env.AI_ASSET_MODEL || 'gpt-4o-mini',
        messages: [{role: 'user', content: prompt}],
        temperature: 0.3,
        response_format: {type: 'json_object'},
      };
      const headers = {'Content-Type': 'application/json'};
      if (process.env.AI_ASSET_KEY) headers.Authorization = 'Bearer ' + process.env.AI_ASSET_KEY;
      const res = await fetch(url, {method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000)});
      const json = await res.json();
      const content = json.choices?.[0]?.message?.content || '';
      const parsed = JSON.parse(stripJsonFence(content));
      const terms = Array.isArray(parsed.terms) ? [...new Set(parsed.terms.map(String).map(t => t.trim()).filter(Boolean))].slice(0, 8) : [];
      value = {terms: terms.length ? terms : localTerms(query), engine: 'ai', aiAvailable: true};
    } catch (e) {
      value = {terms: localTerms(query), engine: 'rule', aiAvailable: false, note: clip(e.message, 60)};
    }
  } else {
    value = {terms: localTerms(query), engine: 'rule', aiAvailable: false};
  }
  semanticCache.set(query, {until: Date.now() + 5 * 60000, value});
  return value;
}

export {DIMENSIONS, MAX_TAG};
