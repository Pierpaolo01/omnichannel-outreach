/** Icons from the approved prototype: 20px grid, 1.6 stroke, round caps. */
import type { ReactNode } from "react";

const paths = {
  call: <path d="M6.5 2.8l2 3.6-1.6 1.5a10 10 0 0 0 5.2 5.2l1.5-1.6 3.6 2-.8 2.8a1.5 1.5 0 0 1-1.6 1C8.6 16.6 3.4 11.4 2.7 5.2a1.5 1.5 0 0 1 1-1.6z" />,
  today: (
    <>
      <rect x="3" y="4" width="14" height="13" rx="2" />
      <path d="M3 8h14M7 2.5v3M13 2.5v3" />
    </>
  ),
  leads: (
    <>
      <circle cx="8" cy="7" r="3" />
      <path d="M2.5 16.5c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5" />
      <path d="M13 4.2a3 3 0 0 1 0 5.6M15 12.3c1.4.6 2.3 1.9 2.6 4.2" />
    </>
  ),
  campaigns: (
    <>
      <rect x="2.5" y="3" width="6" height="5" rx="1.2" />
      <rect x="11.5" y="12" width="6" height="5" rx="1.2" />
      <path d="M8.5 5.5H12a2 2 0 0 1 2 2V12" />
    </>
  ),
  search: (
    <>
      <circle cx="9" cy="9" r="5.5" />
      <path d="M13 13l4 4" />
    </>
  ),
  back: <path d="M12 4.5L6.5 10l5.5 5.5" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

export function Icon({ name, className = "size-[18px]" }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className={`flex-none fill-none stroke-current ${className}`}
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
