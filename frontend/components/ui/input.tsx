import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Fields are the `c-input` family from app/components.css: a token-driven outline that
 * clears 3:1 on every surface, a navy focus border plus a ring, and red on
 * `aria-invalid`. See docs/DESIGN-SYSTEM.md.
 */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = 'text', ...props }, ref) => (
    <input type={type} ref={ref} className={cn('c-input', className)} {...props} />
  ),
);
Input.displayName = 'Input';

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn('c-textarea', className)} {...props} />
));
Textarea.displayName = 'Textarea';

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select ref={ref} className={cn('c-select', className)} {...props}>
    {children}
  </select>
));
Select.displayName = 'Select';
