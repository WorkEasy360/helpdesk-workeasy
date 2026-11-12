'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { searchDestinations, type SearchHit } from '@/lib/modules';
import { useAuthStore } from '@/stores/auth.store';
import { cn } from '@/lib/utils';

/**
 * The top bar's search. It jumps to any module or page the role can open — never to a
 * page the API would refuse. Press `/` or Ctrl+K (⌘K) anywhere to focus it.
 *
 * A combobox with a listbox popup, per WAI-ARIA: Up/Down move the active option,
 * Enter opens it, Escape closes the list.
 */
export function CommandSearch() {
  const router = useRouter();
  const can = useAuthStore((state) => state.can);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const hits = useMemo<SearchHit[]>(() => searchDestinations(query, can), [query, can]);

  // `/` and Ctrl+K focus the field — unless the person is already typing somewhere.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable === true;
      const shortcut = (event.key === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !typing);
      if (!shortcut) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
      setOpen(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => setActiveIndex(0), [query]);

  const go = (hit: SearchHit | undefined) => {
    if (!hit) return;
    setOpen(false);
    setQuery('');
    inputRef.current?.blur();
    router.push(hit.path);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      go(hits[activeIndex]);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    if (!open) {
      setOpen(true);
      return;
    }
    if (hits.length === 0) return;
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    setActiveIndex((index) => (index + delta + hits.length) % hits.length);
  };

  const activeId = hits[activeIndex] ? `${listId}-${activeIndex}` : undefined;

  return (
    <div ref={wrapRef} className="relative w-full max-w-sm">
      <div className="c-search">
        <Search aria-hidden />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          className="c-input"
          placeholder="Search modules and pages…"
          aria-label="Search modules and pages"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open ? activeId : undefined}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {/* The hint is decorative — the shortcut is announced by the field's label. */}
        <kbd
          className="pointer-events-none absolute right-2 hidden rounded-sm border border-border bg-surface-muted px-1.5 py-0.5 text-xs text-secondary sm:block"
          aria-hidden
        >
          /
        </kbd>
      </div>

      {open ? (
        <div className="c-menu absolute left-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)]">
          {hits.length === 0 ? (
            <p className="c-menu-label">Nothing matches “{query}”.</p>
          ) : (
            <ul id={listId} role="listbox" aria-label="Search results">
              {hits.map((hit, index) => {
                const Icon = hit.icon;
                return (
                  <li key={`${hit.path}-${hit.label}`}>
                    <button
                      type="button"
                      id={`${listId}-${index}`}
                      role="option"
                      aria-selected={index === activeIndex}
                      className={cn('c-menu-item', index === activeIndex && 'bg-surface-muted text-foreground')}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => go(hit)}
                    >
                      <Icon aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-foreground">{hit.label}</span>
                        <span className="block truncate text-xs text-secondary">
                          {hit.summary ?? hit.context}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
