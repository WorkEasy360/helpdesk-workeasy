'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface TabItem<T extends string> {
  value: T;
  label: React.ReactNode;
}

function ids(idBase: string, value: string) {
  return { tab: `${idBase}-tab-${value}`, panel: `${idBase}-panel-${value}` };
}

/**
 * `underline` is the design system's `c-tabs`: navy text plus a green indicator on the
 * active tab. `pill` is the segmented control, `c-segmented`.
 */
const variants = {
  underline: { list: 'c-tabs', tab: 'c-tab', active: '', inactive: '' },
  pill: { list: 'c-segmented', tab: '', active: '', inactive: '' },
} as const;

/**
 * WAI-ARIA tabs with automatic activation: roving tabindex, Left/Right (and Home/End)
 * move between tabs. Pair each panel with `<TabPanel idBase value>`.
 */
export function Tabs<T extends string>({
  items,
  value,
  onValueChange,
  idBase,
  label,
  variant = 'underline',
  className,
}: {
  items: readonly TabItem<T>[];
  value: T;
  onValueChange: (value: T) => void;
  idBase: string;
  label: string;
  variant?: keyof typeof variants;
  className?: string;
}) {
  const refs = React.useRef(new Map<T, HTMLButtonElement>());
  const style = variants[variant];

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % items.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    if (next === null) return;
    event.preventDefault();
    const item = items[next];
    if (!item) return;
    onValueChange(item.value);
    refs.current.get(item.value)?.focus();
  };

  return (
    <div role="tablist" aria-label={label} aria-orientation="horizontal" className={cn(style.list, className)}>
      {items.map((item, index) => {
        const selected = item.value === value;
        const { tab, panel } = ids(idBase, item.value);
        return (
          <button
            key={item.value}
            ref={(node) => {
              if (node) refs.current.set(item.value, node);
              else refs.current.delete(item.value);
            }}
            id={tab}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panel}
            tabIndex={selected ? 0 : -1}
            onClick={() => onValueChange(item.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(style.tab, selected ? style.active : style.inactive)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  idBase,
  value,
  className,
  children,
  ...props
}: { idBase: string; value: string } & React.HTMLAttributes<HTMLDivElement>) {
  const { tab, panel } = ids(idBase, value);
  return (
    <div id={panel} role="tabpanel" aria-labelledby={tab} tabIndex={0} className={cn('focus-visible:outline-none', className)} {...props}>
      {children}
    </div>
  );
}
