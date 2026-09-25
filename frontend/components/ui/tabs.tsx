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

const variants = {
  underline: {
    list: 'flex flex-wrap gap-1 border-b border-border',
    tab: '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
    active: 'border-foreground font-medium text-foreground',
    inactive: 'border-transparent text-muted-foreground hover:text-foreground',
  },
  pill: {
    list: 'flex flex-wrap gap-1',
    tab: 'rounded-md px-3 py-1 text-sm transition-colors',
    active: 'bg-muted font-medium text-foreground',
    inactive: 'text-muted-foreground hover:bg-muted hover:text-foreground',
  },
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
            className={cn(
              style.tab,
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
              selected ? style.active : style.inactive,
            )}
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
