'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Buttons are the `c-btn*` classes from app/components.css — see
 * docs/DESIGN-SYSTEM.md. One primary (green) button per view; everything else is
 * secondary, ghost or navy.
 */
const buttonVariants = cva('', {
  variants: {
    variant: {
      /** Green. The one primary action on the view. */
      default: 'c-btn-primary',
      /** Outlined. The common case. */
      outline: 'c-btn',
      ghost: 'c-btn-ghost',
      destructive: 'c-btn-danger',
      /** Navy — a high-emphasis action that is not *the* primary one. */
      dark: 'c-btn-dark',
      link: 'inline-flex items-center gap-1 text-base font-medium text-link underline underline-offset-2',
    },
    size: {
      default: '',
      sm: 'c-btn-sm',
      icon: 'c-btn-icon',
      'icon-sm': 'c-btn-icon c-btn-sm',
    },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild = false, loading = false, children, disabled, ...props },
    ref,
  ) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size }), className)}
        ref={ref}
        disabled={disabled ?? loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {children}
          </>
        ) : (
          children
        )}
      </Comp>
    );
  },
);
Button.displayName = 'Button';
export { buttonVariants };
