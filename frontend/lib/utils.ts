import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function initials(first: string, last?: string | null): string {
  return `${first.charAt(0)}${last?.charAt(0) ?? ''}`.toUpperCase();
}

/**
 * Validates a post-sign-in return path. Only same-origin absolute paths are allowed:
 * it must start with a single '/', so '//evil.example' and '/\evil.example' (which
 * browsers treat as protocol-relative) and full URLs are all rejected.
 */
export function safeReturnPath(value: string | null | undefined, fallback: string): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return fallback;
  }
  if (/[\u0000-\u001f]/.test(value)) {
    return fallback;
  }
  return value;
}
