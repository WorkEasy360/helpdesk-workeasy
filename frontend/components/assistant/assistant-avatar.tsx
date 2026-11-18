/**
 * The assistant's face — see docs/AI-ASSISTANT-UI.md.
 *
 * One component, no image files and no icon library. Every colour is a token, so it
 * follows light and dark on its own and works unchanged on a customer-branded help
 * centre, where those tokens are remapped to the organization's own colour.
 *
 * The viewBox is the mark's own bounding box — 32 wide by 30 tall, antenna tip to chin
 * — which is what lets `.c-fab-face` size it as a percentage of the disc.
 */
export function AssistantAvatar({
  className = 'size-icon',
  title,
}: {
  className?: string;
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 32 30"
      className={className}
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      fill="none"
    >
      <path d="M15.6 5.6v3.8" stroke="var(--we-on-primary)" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="15.6" cy="2.8" r="2.8" fill="var(--we-accent)" />
      <rect x="0" y="13.6" width="5.6" height="8.2" rx="2.4" fill="var(--we-on-primary)" />
      <rect x="26.4" y="13.6" width="5.6" height="8.2" rx="2.4" fill="var(--we-on-primary)" />
      <rect x="3.9" y="8.6" width="24.2" height="21.4" rx="7.8" fill="var(--we-on-primary)" />
      <rect x="7" y="12.3" width="18" height="11.1" rx="5.5" fill="var(--we-primary)" />
      <path
        d="M9.6 18.7h3.6M18.4 18.7h3.6"
        stroke="var(--we-accent)"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <path d="M14 27.1q1.6 1.5 3.2 0" stroke="var(--we-primary)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
