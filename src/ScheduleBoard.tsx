import React, {useMemo, useState} from 'react';
import {ChevronLeft, ChevronRight, Download} from 'lucide-react';
import type {DB, Session} from './service';

type Status = {label: string; tone: string};

type Props = {
  db: DB;
  filter: string;
  mode: 'week' | 'month';
  canManage: boolean;
  teacher: (id: string) => string | undefined;
  venue: (id: string) => string | undefined;
  serviceLabel: (s: Session) => string;
  peopleText: (s: Session) => string;
  statusOf: (s: Session) => Status;
  onOpen: (s: Session) => void;
  onCreate: (date: string, hour: number) => void;
  onDay: (list: Session[], date: string) => void;
  onExportCalendar?: () => void;
};

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const md = (d: Date) => `${d.getMonth() + 1}.${pad(d.getDate())}`;
const weekdayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const typeClass = (t: string) => (t === '公益课' ? 'public' : t === '定制团队课' ? 'custom' : 'solo');
const typeName = (t: string) => (t === '公益课' ? '公益课' : t === '定制团队课' ? '定制团队课' : '一对一');

/** 把 "YYYY-MM-DDTHH:mm" 解析成本地时间，避免时区偏移把日期算错 */
const parse = (iso: string) => {
  const [d, t = '00:00'] = iso.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  return new Date(y, m - 1, day, hh, mm, 0, 0);
};
const dateKey = (iso: string) => iso.slice(0, 10);
const hm = (iso: string) => iso.slice(11, 16);
const mondayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));

/** 统计图例：三种课程类型的场次数量（已取消不计入类型计数，单独提示） */
function legendCounts(list: Session[]) {
  const counts = {'公益课': 0, '定制团队课': 0, '一对一': 0} as Record<string, number>;
  let cancelled = 0;
  list.forEach(s => {
    if (s.cancelled) {
      cancelled += 1;
      return;
    }
    counts[s.type] = (counts[s.type] || 0) + 1;
  });
  return {counts, cancelled};
}

function Legend({list}: {list: Session[]}) {
  const {counts, cancelled} = legendCounts(list);
  return (
    <div className="schedlegend" aria-label="图例">
      <span className="legenditem"><i className="swatch public" />公益课 <b>{counts['公益课']}</b></span>
      <span className="legenditem"><i className="swatch custom" />定制团队课 <b>{counts['定制团队课']}</b></span>
      <span className="legenditem"><i className="swatch solo" />一对一 <b>{counts['一对一']}</b></span>
      {cancelled > 0 && <span className="legenditem"><i className="swatch canceled" />已取消 <b>{cancelled}</b></span>}
      <span className="legendstatus">
        <i className="dot amber" />资料待补
        <i className="dot blue" />待复盘
        <i className="dot green" />已齐全
      </span>
    </div>
  );
}

/* ---------------- 周视图 ---------------- */

type Block = {s: Session; startMin: number; endMin: number; lane: number; lanes: number; cross: boolean};

function packLanes(items: Block[]) {
  const cluster: Block[] = [];
  const flush = () => {
    const laneEnd: number[] = [];
    cluster.forEach(it => {
      let lane = laneEnd.findIndex(e => e <= it.startMin);
      if (lane < 0) {
        lane = laneEnd.length;
        laneEnd.push(it.endMin);
      } else {
        laneEnd[lane] = it.endMin;
      }
      it.lane = lane;
    });
    cluster.forEach(it => (it.lanes = Math.max(1, laneEnd.length)));
    cluster.length = 0;
  };
  items.forEach(it => {
    if (cluster.length && it.startMin >= Math.max(...cluster.map(c => c.endMin))) flush();
    cluster.push(it);
  });
  if (cluster.length) flush();
}

function WeekView(props: Props & {sessions: Session[]}) {
  const {sessions, canManage, teacher, venue, serviceLabel, peopleText, statusOf, onOpen, onCreate, onExportCalendar} = props;
  const [offset, setOffset] = useState(0);
  const todayKey = ymd(new Date());
  const monday = mondayOf(new Date());
  monday.setDate(monday.getDate() + offset * 7);
  const days = weekdayNames.map((label, i) => {
    const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    return {d, key: ymd(d), label, primary: i === 0};
  });
  const weekEnd = days[6].d;
  const list = sessions
    .filter(s => dateKey(s.start) >= days[0].key && dateKey(s.start) <= days[6].key)
    .sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name));

  // 时间轴：默认 08—22，必要时向两端扩展整小时
  let startHour = 8;
  let endHour = 22;
  list.forEach(s => {
    const st = parse(s.start);
    const en = parse(s.end);
    if (en <= st) return;
    startHour = Math.min(startHour, st.getHours());
    const cross = dateKey(s.end) > dateKey(s.start);
    const rawEnd = cross ? 24 : en.getHours() + (en.getMinutes() > 0 ? 1 : 0);
    endHour = Math.max(endHour, Math.min(24, rawEnd));
  });
  const hourCount = Math.max(1, endHour - startHour);
  const pxPerHour = 64;
  const bodyHeight = hourCount * pxPerHour;
  const scale = pxPerHour / 60;

  const blocks = useMemo(() => {
    const map: Record<string, Block[]> = {};
    list.forEach(s => {
      const st = parse(s.start);
      const en = parse(s.end);
      if (en <= st) {
        console.warn('排期数据异常：结束时间早于开始时间，已跳过渲染', s.id, s.start, s.end);
        return;
      }
      const cross = dateKey(s.end) > dateKey(s.start);
      const startMin = st.getHours() * 60 + st.getMinutes();
      const endMin = cross ? endHour * 60 : en.getHours() * 60 + en.getMinutes();
      if (endMin <= startMin) return;
      const key = dateKey(s.start);
      (map[key] = map[key] || []).push({s, startMin, endMin, cross, lane: 0, lanes: 1});
    });
    Object.keys(map).forEach(k => packLanes(map[k]));
    return map;
  }, [list.map(s => s.id + s.start + s.end).join('|'), endHour]);

  const hours = Array.from({length: hourCount}, (_, i) => startHour + i);
  const weekCancelled = list.length;

  return (
    <div className="schedboard">
      <div className="schedbar">
        <div className="schednav">
          <button onClick={() => setOffset(offset - 1)} aria-label="上一周"><ChevronLeft size={15} />上周</button>
          <button className={offset === 0 ? 'on' : ''} onClick={() => setOffset(0)} disabled={offset === 0}>本周</button>
          <button onClick={() => setOffset(offset + 1)} aria-label="下一周">下周<ChevronRight size={15} /></button>
        </div>
        <p className="schedrange">{offset === 0 ? '本周' : '该周'}（{md(days[0].d)} — {md(weekEnd)}）· 共 <b>{weekCancelled}</b> 场</p>
        {onExportCalendar && <button type="button" className="schedexport" onClick={onExportCalendar}><Download size={14} />导出排期日历</button>}
        <Legend list={list} />
      </div>
      <div className="schedscroll">
        <div className="schedframe" style={{minWidth: 980}}>
          <div className="schedhead" style={{paddingLeft: 66}}>
            {days.map(d => <div key={d.key} className={'scheddayhead' + (d.key === todayKey ? ' today' : '')}><span>{d.label}</span><b>{md(d.d)}</b>{d.key === todayKey && <em>今天</em>}</div>)}
          </div>
          <div className="schedbody" style={{height: bodyHeight}}>
            <div className="schedtime" style={{width: 66}}>
              {hours.map(h => <div key={h} style={{height: pxPerHour}}><span>{pad(h)}:00</span></div>)}
            </div>
            {days.map((d, di) => (
              <div key={d.key} className={'schedcol' + (d.key === todayKey ? ' today' : '')} style={{gridColumn: di + 2, height: bodyHeight, cursor: canManage ? 'copy' : 'default'}} title={canManage ? '点击空白时段新建排课' : undefined}
                onClick={e => {
                  if (!canManage) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const y = e.clientY - rect.top;
                  const hour = Math.max(startHour, Math.min(endHour - 1, Math.floor(y / pxPerHour) + startHour));
                  onCreate(d.key, hour);
                }}>
                <div className="schedlines" style={{backgroundSize: `100% ${pxPerHour}px`}} />
                {(blocks[d.key] || []).map(b => {
                  const top = (b.startMin - startHour * 60) * scale;
                  const height = Math.max(24, Math.min((b.endMin - b.startMin) * scale, bodyHeight - top));
                  const compact = (b.endMin - b.startMin) < 60;
                  const st = statusOf(b.s);
                  const width = `calc(${100 / b.lanes}% - 6px)`;
                  const left = `calc(${(b.lane * 100) / b.lanes}% + 3px)`;
                  return (
                    <div key={b.s.id} data-sid={b.s.id} className={'schedblock ' + typeClass(b.s.type) + (b.s.cancelled ? ' cancelled' : '') + (compact ? ' compact' : '') + (height < 82 ? ' tight' : '') + (b.lanes > 1 ? ' narrow' : '')}
                      style={{top, height, left, width}} title={b.s.name + ' · ' + st.label}
                      onClick={e => {e.stopPropagation(); onOpen(b.s)}}>
                      <span className={'schedstat ' + st.tone} title={'交付状态：' + st.label} />
                      <div className="schedname">{b.s.name}{b.s.cancelled && <i className="sbcancel">已取消</i>}</div>
                      <div className="schedmeta">{hm(b.s.start)}–{hm(b.s.end)}{b.cross && <em>（次日结束）</em>}</div>
                      {!compact && <div className="schedmeta">{serviceLabel(b.s)}</div>}
                      {!compact && <div className="schedmeta">{teacher(b.s.teacher)} · {venue(b.s.venue)}</div>}
                      {!compact && <div className="schedmeta schedpeople">{peopleText(b.s)}</div>}
                      {!compact && <div className="schedtag"><span className={'schedtype ' + typeClass(b.s.type)}>{typeName(b.s.type)}</span><span className={'schedtagstat ' + st.tone}>{st.label}</span></div>}
                    </div>
                  );
                })}
              </div>
            ))}
            {!list.length && <div className="schedempty">本周暂无排期，可点击『新建排课』安排课程。</div>}
          </div>
        </div>
      </div>
      <p className="schedhint">点击课块查看场次详情；{canManage ? '点击网格空白时段可直接在该时段新建排课；' : ''}灰底虚线课块为已取消场次，保留历史追溯。</p>
    </div>
  );
}

/* ---------------- 月视图 ---------------- */

function MonthView(props: Props & {sessions: Session[]}) {
  const {sessions, statusOf, serviceLabel, teacher, venue, onDay, onOpen, onExportCalendar} = props;
  const [offset, setOffset] = useState(0);
  const base = new Date();
  const anchor = new Date(base.getFullYear(), base.getMonth() + offset, 1);
  const gridStart = mondayOf(anchor);
  const daysInMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
  const lead = (anchor.getDay() + 6) % 7;
  const rows = Math.ceil((lead + daysInMonth) / 7);
  const cells = Array.from({length: rows * 7}, (_, i) => {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    return {d, key: ymd(d), inMonth: d.getMonth() === anchor.getMonth()};
  });
  const monthKey = `${anchor.getFullYear()}-${pad(anchor.getMonth() + 1)}`;
  const monthList = sessions.filter(s => dateKey(s.start).startsWith(monthKey)).sort((a, b) => a.start.localeCompare(b.start));
  const todayKey = ymd(new Date());
  const rowCount = rows;
  const stats = legendCounts(monthList);
  const pendingMaterials = monthList.filter(s => !s.cancelled && statusOf(s).label === '资料待补').length;
  const pendingReviews = monthList.filter(s => !s.cancelled && statusOf(s).label === '待复盘').length;

  const byDay: Record<string, Session[]> = {};
  monthList.forEach(s => ((byDay[dateKey(s.start)] = byDay[dateKey(s.start)] || []).push(s)));

  const dayTone = (list: Session[]) => {
    if (list.some(s => !s.cancelled && statusOf(s).label === '资料待补')) return 'amber';
    if (list.some(s => !s.cancelled && statusOf(s).label === '待复盘')) return 'blue';
    if (list.some(s => !s.cancelled)) return 'green';
    return '';
  };

  return (
    <div className="schedboard month">
      <div className="schedbar">
        <div className="schednav">
          <button onClick={() => setOffset(offset - 1)} aria-label="上一月"><ChevronLeft size={15} />上月</button>
          <button className={offset === 0 ? 'on' : ''} onClick={() => setOffset(0)} disabled={offset === 0}>本月</button>
          <button onClick={() => setOffset(offset + 1)} aria-label="下一月">下月<ChevronRight size={15} /></button>
        </div>
        <p className="schedrange">{offset === 0 ? '本月' : '该月'}（{anchor.getFullYear()} 年 {anchor.getMonth() + 1} 月）· 共 <b>{monthList.length}</b> 场</p>
        {onExportCalendar && <button type="button" className="schedexport" onClick={onExportCalendar}><Download size={14} />导出排期日历</button>}
        <Legend list={monthList} />
      </div>
      <div className="monthstats">
        当月共 <b>{monthList.length}</b> 场（公益 {stats.counts['公益课']} · 定制 {stats.counts['定制团队课']} · 一对一 {stats.counts['一对一']}）、已取消 <b>{stats.cancelled}</b>、待补资料 <b>{pendingMaterials}</b>、待复盘 <b>{pendingReviews}</b>
      </div>
      <div className="monthwrap">
        <div className="monthweek">{weekdayNames.map(w => <div key={w}>{w}</div>)}</div>
        <div className="monthgrid">
        {cells.map(c => {
          const list = byDay[c.key] || [];
          const tone = dayTone(list);
          return (
            <button key={c.key} type="button" className={'monthcell' + (c.inMonth ? '' : ' outside') + (c.key === todayKey ? ' today' : '') + (list.length >= 4 ? ' dense' : '')}
              onClick={() => onDay(list, c.key)} disabled={!list.length} aria-label={c.key + (list.length ? ` ${list.length} 场` : ' 无排期')}>
              <span className="monthdate">{c.d.getDate()}{c.key === todayKey && <em>今天</em>}</span>
              <div className="monthchips">
                {list.slice(0, 3).map(s => (
                  <span key={s.id} data-sid={s.id} className={'monthchip ' + typeClass(s.type) + (s.cancelled ? ' cancelled' : '')}
                    onClick={e => {e.stopPropagation(); onOpen(s)}} title={s.name + ' · ' + serviceLabel(s)}>
                    {hm(s.start)} {s.name}
                  </span>
                ))}
                {list.length > 3 && <span className="monthmore">+{list.length - 3}</span>}
              </div>
              {tone && <i className={'dot ' + tone} />}
            </button>
          );
        })}
        {!monthList.length && <div className="schedempty">本月暂无排期，可点击『新建排课』安排课程。</div>}
        </div>
      </div>
      <p className="schedhint">点击日期查看当日全部场次；点击彩色小条直接打开该场详情。日期加粗表示当日 4 场及以上，右上圆点提示当天最紧急状态。</p>
      <div className="monthfoot">课程类型 <span><i className="swatch public" />公益课</span><span><i className="swatch custom" />定制团队课</span><span><i className="swatch solo" />一对一</span><span>讲师示例：{teacher('T1')} · 场地示例：{venue('L1')}</span></div>
    </div>
  );
}

export default function ScheduleBoard(props: Props) {
  const sessions = useMemo(() => props.db.sessions.filter(s => !props.filter || s.type === props.filter), [props.db.sessions, props.filter]);
  return props.mode === 'week' ? <WeekView {...props} sessions={sessions} /> : <MonthView {...props} sessions={sessions} />;
}
