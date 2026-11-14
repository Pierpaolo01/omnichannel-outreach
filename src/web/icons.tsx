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
  file: (
    <>
      <path d="M5 2.5h6.5L15 6v11.5H5z" />
      <path d="M11.5 2.5V6H15M7.5 10.5h5M7.5 13.5h5" />
    </>
  ),
  ok: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M6.8 10.2l2.2 2.2 4.2-4.6" />
    </>
  ),
  bad: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6.3v4.4M10 13.4v.2" />
    </>
  ),
  upload: (
    <>
      <path d="M10 13V3.8M6.3 7.3L10 3.6l3.7 3.7" />
      <path d="M3.5 12.5v2.5a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5v-2.5" />
    </>
  ),
  plus: <path d="M10 4.5v11M4.5 10h11" />,
  email: (
    <>
      <rect x="3" y="4.8" width="14" height="10.4" rx="1.6" />
      <path d="M3.6 5.6L10 10.6l6.4-5" />
    </>
  ),
  sms: <path d="M4.5 4.5h11a1.5 1.5 0 0 1 1.5 1.5v6.5a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 2.6V14h-1A1.5 1.5 0 0 1 3 12.5V6a1.5 1.5 0 0 1 1.5-1.5z" />,
  clock: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6.2V10l2.6 1.6" />
    </>
  ),
  warn: (
    <>
      <path d="M10 3.4l7.2 12.6H2.8z" />
      <path d="M10 8.2v3.6M10 14v.1" />
    </>
  ),
  close: <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />,
  chevron: <path d="M5.5 8l4.5 4.5L14.5 8" />,
  forward: <path d="M8 4.5l5.5 5.5L8 15.5" />,
  reply: (
    <>
      <path d="M8 6L3.8 10 8 14" />
      <path d="M4.2 10h7.3a4.5 4.5 0 0 1 4.5 4.5v.5" />
    </>
  ),
  system: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 9.2v4.2M10 6.6v.1" />
    </>
  ),
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
