import type {DB, Session} from './service';

export type IcsEvent = {
  uid: string;
  start: string;
  end: string;
  summary: string;
  location: string;
  description: string;
  cancelled?: boolean;
};

export type IcsOptions = {calName?: string; reminderMinutes?: number; now?: Date};
export type IcsRange = 'week' | 'month' | 'next30' | 'all';

export const REMINDERS = [
  {value: 10, label: '提前 10 分钟'},
  {value: 30, label: '提前 30 分钟（推荐）'},
  {value: 60, label: '提前 1 小时'},
  {value: 1440, label: '提前 1 天'},
];

const CRLF = '\r\n';
const p2 = (n: number) => String(n).padStart(2, '0');
const TIMEZONE = 'Asia/Shanghai';

/** "YYYY-MM-DDTHH:mm" → "YYYYMMDDTHHmm00"（按字面时间，不做时区换算） */
const local = (value: string) => value.slice(0, 10).replace(/-/g, '') + 'T' + value.slice(11, 16).replace(':', '') + '00';

const utcStamp = (now: Date) =>
  `${now.getUTCFullYear()}${p2(now.getUTCMonth() + 1)}${p2(now.getUTCDate())}T${p2(now.getUTCHours())}${p2(now.getUTCMinutes())}${p2(now.getUTCSeconds())}Z`;

const triggerOf = (minutes: number) => {
  if (minutes % 1440 === 0) return '-P' + minutes / 1440 + 'D';
  if (minutes % 60 === 0) return '-PT' + minutes / 60 + 'H';
  return '-PT' + Math.max(1, Math.round(minutes)) + 'M';
};

/** RFC 5545 文本转义：反斜杠、分号、逗号、换行 */
export function escapeIcs(value: string) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

const encoder = new TextEncoder();
/** RFC 5545 折行：每行（含续行前导空格）不超过 75 字节 */
export function foldLine(line: string) {
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = '';
  let limit = 75;
  for (const ch of line) {
    const next = current + ch;
    if (encoder.encode(next).length > limit) {
      out.push(current);
      current = ' ' + ch;
      limit = 74;
    } else {
      current = next;
    }
  }
  out.push(current);
  return out.join(CRLF);
}

const V_TIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Asia/Shanghai',
  'X-LIC-LOCATION:Asia/Shanghai',
  'BEGIN:STANDARD',
  'DTSTART:19700101T000000',
  'TZOFFSETFROM:+0800',
  'TZOFFSETTO:+0800',
  'TZNAME:CST',
  'END:STANDARD',
  'END:VTIMEZONE',
];

/** 生成标准 iCalendar 文本（CRLF 换行、TZID 固定 Asia/Shanghai、可选 VALARM） */
export function toIcs(events: IcsEvent[], opts: IcsOptions = {}) {
  const now = opts.now || new Date();
  const calName = opts.calName || '核心方法排期';
  const reminder = opts.reminderMinutes === 0 ? 0 : (opts.reminderMinutes || 30);
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//core-method-panel//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:' + escapeIcs(calName),
    'X-WR-TIMEZONE:' + TIMEZONE,
    ...V_TIMEZONE,
  ];
  events.slice().sort((a, b) => a.start.localeCompare(b.start)).forEach(ev => {
    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + escapeIcs(ev.uid));
    lines.push('DTSTAMP:' + utcStamp(now));
    lines.push('DTSTART;TZID=' + TIMEZONE + ':' + local(ev.start));
    lines.push('DTEND;TZID=' + TIMEZONE + ':' + local(ev.end));
    lines.push('SUMMARY:' + escapeIcs(ev.summary));
    lines.push('LOCATION:' + escapeIcs(ev.location || ''));
    lines.push('DESCRIPTION:' + escapeIcs(ev.description || ''));
    lines.push('STATUS:' + (ev.cancelled ? 'CANCELLED' : 'CONFIRMED'));
    lines.push('TRANSP:OPAQUE');
    if (!ev.cancelled && reminder > 0) {
      lines.push('BEGIN:VALARM');
      lines.push('ACTION:DISPLAY');
      lines.push('DESCRIPTION:' + escapeIcs('课程即将开始：' + ev.summary));
      lines.push('TRIGGER:' + triggerOf(reminder));
      lines.push('END:VALARM');
    }
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join(CRLF) + CRLF;
}

const nameOf = (db: DB, id: string) => db.profiles.find(p => p.id === id)?.name;

function objectLabel(db: DB, s: Session) {
  const client = s.client ? db.profiles.find(p => p.id === s.client) : undefined;
  if (client) return (client.type === '渠道方' || client.roles?.includes('渠道方') ? '渠道：' : '客户：') + client.name;
  if (s.type === '一对一') return nameOf(db, s.people[0]) || '一对一';
  return s.people.length ? s.people.length + ' 位学员' : '公益开放';
}

function peopleLabel(db: DB, s: Session) {
  const names = s.people.map(id => nameOf(db, id)).filter(Boolean) as string[];
  if (s.type === '一对一') return names.join('、') || '—';
  const head = names.slice(0, 3).join('、');
  return names.length > 3 ? head + ' 等 ' + names.length + ' 人' : head || '—';
}

function deliveryOf(db: DB, s: Session) {
  if (s.cancelled) return '已取消';
  const mats = db.materials.filter(m => m.session === s.id);
  const parts = db.participations.filter(p => p.session === s.id);
  const attended = parts.filter(p => p.attendance === '已出席');
  const prep = mats.some(m => m.category === '课前准备资料');
  const ppt = mats.some(m => m.category === '课上 PPT');
  const outputs = attended.length > 0 && attended.every(p => mats.some(m => m.category === '学员产出' && m.person === p.person));
  const complete = prep && ppt && outputs && parts.every(p => p.attendance !== '待确认');
  if (!complete) return '资料待补';
  return db.reviews.some(r => r.session === s.id && r.submitted) ? '已齐全' : '待复盘';
}

/** Session → VEVENT 字段；前端导出与服务端订阅共用，避免两份生成逻辑分叉 */
export function sessionEvent(db: DB, s: Session): IcsEvent {
  const teacherName = db.teachers.find(t => t.id === s.teacher)?.name || '待定';
  const venueName = db.venues.find(v => v.id === s.venue)?.name || '待定';
  const summary = s.name + '（' + s.type + '）' + (s.cancelled ? '（已取消）' : '');
  const lines = [
    '主讲：' + teacherName,
    '对象：' + objectLabel(db, s),
    '类型：' + s.type,
    '参与人：' + peopleLabel(db, s),
    '交付：' + deliveryOf(db, s),
  ];
  if (s.note) lines.push('备注：' + s.note);
  lines.push('由核心方法管理面板排期生成，详情见系统排课页。');
  return {
    uid: s.id + '@core-method-panel',
    start: s.start,
    end: s.end,
    summary,
    location: venueName,
    description: lines.join(' · '),
    cancelled: s.cancelled,
  };
}

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const ymd = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

/** 范围口径：本周（周一起）、本月、未来 30 天（含今天）、全部 */
export function rangeOf(range: IcsRange, now = new Date()) {
  if (range === 'all') return {from: '', to: ''};
  if (range === 'month') {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return {from: ymd(first), to: ymd(last)};
  }
  if (range === 'next30') return {from: ymd(now), to: ymd(addDays(now, 29))};
  const monday = addDays(now, -((now.getDay() + 6) % 7));
  return {from: ymd(monday), to: ymd(addDays(monday, 6))};
}

export const rangeLabels: Record<IcsRange, string> = {week: '本周', month: '本月', next30: '未来 30 天', all: '全部场次'};

/** 过滤出范围内场次（含已取消，便于日历端同步撤订） */
export function sessionsInRange(db: DB, range: IcsRange, opts: {teacher?: string; venue?: string; now?: Date} = {}) {
  const {from, to} = rangeOf(range, opts.now);
  return db.sessions
    .filter(s => !s.archived)
    .filter(s => (!from || s.start.slice(0, 10) >= from) && (!to || s.start.slice(0, 10) <= to))
    .filter(s => !opts.teacher || s.teacher === opts.teacher)
    .filter(s => !opts.venue || s.venue === opts.venue)
    .sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name));
}

export function icsFileName(label: string) {
  const clean = String(label || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '').slice(0, 40);
  return '核心方法排期' + (clean ? '_' + clean : '') + '.ics';
}
