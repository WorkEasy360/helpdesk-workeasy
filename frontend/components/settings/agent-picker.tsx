'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { usersService } from '@/services/settings.service';
import { Input } from '@/components/ui/input';

export interface PickedAgent {
  id: string;
  name: string;
}

interface Props {
  id: string;
  value: PickedAgent[];
  onChange: (value: PickedAgent[]) => void;
  disabled?: boolean;
}

/**
 * Multi-select for agents that searches the server as you type, so it works for any
 * team size instead of only the first page of users. Chosen agents are kept with their
 * names so they stay visible while the search results change.
 */
export function AgentPicker({ id, value, onChange, disabled }: Props) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const results = useQuery({
    queryKey: ['users', 'picker', query],
    queryFn: () =>
      usersService.list({ page: 1, pageSize: 20, isActive: true, ...(query ? { q: query } : {}) }),
    enabled: !disabled,
    staleTime: 30_000,
  });

  const selected = new Set(value.map((agent) => agent.id));

  const toggle = (agent: PickedAgent, checked: boolean) =>
    onChange(checked ? [...value, agent] : value.filter((entry) => entry.id !== agent.id));

  return (
    <div className="space-y-2">
      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-1" aria-label="Selected members">
          {value.map((agent) => (
            <li
              key={agent.id}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs"
            >
              {agent.name}
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${agent.name}`}
                disabled={disabled}
                onClick={() => toggle(agent, false)}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No members selected.</p>
      )}

      <Input
        id={id}
        type="search"
        placeholder="Search agents by name or email"
        value={search}
        disabled={disabled}
        onChange={(event) => setSearch(event.target.value)}
        onKeyDown={(event) => {
          // Enter in the search box should not submit the surrounding form.
          if (event.key === 'Enter') event.preventDefault();
        }}
      />

      <div className="max-h-40 space-y-1 overflow-y-auto" aria-live="polite">
        {results.isPending ? (
          <p className="text-base text-muted-foreground">Loading agents…</p>
        ) : results.isError ? (
          <p className="text-base text-destructive">
            Unable to load agents.{' '}
            <button type="button" className="underline" onClick={() => results.refetch()}>
              Try again
            </button>
          </p>
        ) : results.data.items.length === 0 ? (
          <p className="text-base text-muted-foreground">No agents match that search.</p>
        ) : (
          <>
            {results.data.items.map((agent) => {
              const picked = { id: agent.id, name: `${agent.firstName} ${agent.lastName}` };
              return (
                <label key={agent.id} className="flex items-center gap-2 text-base">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-input"
                    checked={selected.has(agent.id)}
                    disabled={disabled}
                    onChange={(event) => toggle(picked, event.target.checked)}
                  />
                  {picked.name}
                  <span className="text-xs text-muted-foreground">{agent.email}</span>
                </label>
              );
            })}
            {results.data.meta.total > results.data.items.length ? (
              <p className="pt-1 text-xs text-muted-foreground">
                Showing {results.data.items.length} of {results.data.meta.total} — refine the search
                to find others.
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
