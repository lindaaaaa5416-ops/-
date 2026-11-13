import React from 'react';
import {useEffect, useMemo, useRef, useState} from 'react';
import {Check, Search, X} from 'lucide-react';
import {MAX_TAGS, TAG_GROUPS} from './tag-library';
import {normalizeTags} from './service';

/** 列表 / 详情里的只读标签展示：最多显示 max 个，其余折叠为 +N */
export function TagList({tags, max = 3}: {tags?: string[]; max?: number}) {
  const list = normalizeTags(tags);
  if (!list.length) return <>—</>;
  return (
    <span className="taglist">
      {list.slice(0, max).map(t => <span className="badge" key={t}>{t}</span>)}
      {list.length > max && <span className="badge tagmore">+{list.length - max}</span>}
    </span>
  );
}

/** 可搜索、可自定义、可移除的标签输入组件（最多 10 个，单个 ≤12 字） */
export function TagInput({value, onChange, disabled = false}: {value: string[]; onChange: (v: string[]) => void; disabled?: boolean}) {
  const list = normalizeTags(value);
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hint, setHint] = useState('');
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDoc);
    return () => document.removeEventListener('pointerdown', onDoc);
  }, []);

  const groups = useMemo(() => {
    const q = query.trim();
    return TAG_GROUPS.map(g => ({name: g.name, tags: q ? g.tags.filter(t => t.includes(q)) : g.tags})).filter(g => g.tags.length);
  }, [query]);

  const add = (raw: string) => {
    const t = String(raw || '').trim().replace(/\s+/g, ' ');
    if (!t) return;
    if (t.length > 12) { setHint('单个标签不超过 12 个字符'); return; }
    if (list.includes(t)) { setHint('该标签已添加，无需重复选择'); return; }
    if (list.length >= MAX_TAGS) { setHint('最多选择 10 个标签'); return; }
    onChange([...list, t]);
    setDraft('');
    setHint('');
  };
  const remove = (t: string) => { onChange(list.filter(x => x !== t)); setHint(''); };
  const toggle = (t: string) => (list.includes(t) ? remove(t) : add(t));

  return (
    <div className="tagfield" ref={wrap}>
      <div className={'tagbox' + (open ? ' open' : '') + (disabled ? ' disabled' : '')} onClick={() => !disabled && setOpen(true)}>
        {list.map(t => (
          <span className="tagchip" key={t}>
            {t}
            {!disabled && <button type="button" aria-label={'移除标签 ' + t} onClick={e => { e.stopPropagation(); remove(t); }}><X size={11} /></button>}
          </span>
        ))}
        <input className="taginput" disabled={disabled} value={draft} aria-label="人群标签输入"
          placeholder={list.length ? '继续添加' : '点击选择标签，或输入自定义标签后回车'}
          onChange={e => setDraft(e.target.value)}
          onFocus={() => !disabled && setOpen(true)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); add(draft); }
            else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
            else if (e.key === 'Backspace' && !draft && list.length) remove(list[list.length - 1]);
          }} />
      </div>
      {open && !disabled && (
        <div className="tagpanel">
          <div className="tagsearch">
            <Search size={14} />
            <input value={query} aria-label="搜索标签" placeholder="搜索标签（如：本科、二孩、职业转型）"
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
                if (e.key === 'Enter' && query.trim()) { e.preventDefault(); add(query); }
              }} />
          </div>
          {groups.map(g => (
            <div className="taggroup" key={g.name}>
              <span className="taggrouphead">{g.name}</span>
              <div className="tagoptions">
                {g.tags.map(t => (
                  <button type="button" key={t} className={'tagopt' + (list.includes(t) ? ' on' : '')} onClick={() => toggle(t)}>
                    {t}{list.includes(t) && <Check size={11} />}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {!groups.length && <p className="tagempty">没有匹配的标签，可在输入框回车添加为自定义标签。</p>}
          <p className="tagfoot">已选 {list.length} / {MAX_TAGS} 个 · 最多 10 个，单个标签不超过 12 个字符；输入框回车可添加自定义标签。</p>
        </div>
      )}
      {hint && <p className="taghint" role="status">{hint}</p>}
    </div>
  );
}

