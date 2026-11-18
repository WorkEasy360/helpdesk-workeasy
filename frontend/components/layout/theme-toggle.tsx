'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme, type Theme } from '@/components/theme-provider';
import { Button } from '@/components/ui/button';

const ORDER: Theme[] = ['system', 'light', 'dark'];

const LABEL: Record<Theme, string> = {
  system: 'Theme: follow the system',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

/**
 * The top bar's theme toggle. Dark mode follows the operating system until someone
 * chooses here; the choice is then saved per browser and applied before first paint.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length] ?? 'system';

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(next)}
      aria-label={`${LABEL[theme]}. Switch to ${LABEL[next].replace('Theme: ', '')}.`}
      title={LABEL[theme]}
    >
      <Icon className="h-4 w-4" aria-hidden />
    </Button>
  );
}
