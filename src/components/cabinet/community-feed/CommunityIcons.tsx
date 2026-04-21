interface IconProps {
  className?: string;
}

export function MembersCountIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 19" className={className} aria-hidden="true" fill="none">
      <path
        d="M6.00016 4.33337C4.2535 4.33337 2.8335 5.75337 2.8335 7.50004C2.8335 9.21337 4.1735 10.6 5.92016 10.66C5.9735 10.6534 6.02683 10.6534 6.06683 10.66C6.08016 10.66 6.08683 10.66 6.10016 10.66C6.10683 10.66 6.10683 10.66 6.1135 10.66C7.82016 10.6 9.16016 9.21337 9.16683 7.50004C9.16683 5.75337 7.74683 4.33337 6.00016 4.33337Z"
        fill="currentColor"
      />
      <path
        d="M9.38664 12.4333C7.52664 11.1933 4.49331 11.1933 2.61997 12.4333C1.77331 13 1.30664 13.7666 1.30664 14.5866C1.30664 15.4066 1.77331 16.1666 2.61331 16.7266C3.54664 17.3533 4.77331 17.6666 5.99997 17.6666C7.22664 17.6666 8.45331 17.3533 9.38664 16.7266C10.2266 16.16 10.6933 15.4 10.6933 14.5733C10.6866 13.7533 10.2266 12.9933 9.38664 12.4333Z"
        fill="currentColor"
      />
      <path
        d="M13.3267 7.89344C13.4334 9.18677 12.5134 10.3201 11.2401 10.4734C11.2334 10.4734 11.2334 10.4734 11.2267 10.4734H11.2067C11.1667 10.4734 11.1267 10.4734 11.0934 10.4868C10.4467 10.5201 9.8534 10.3134 9.40674 9.93344C10.0934 9.32011 10.4867 8.40011 10.4067 7.40011C10.3601 6.86011 10.1734 6.36677 9.89341 5.94677C10.1467 5.82011 10.4401 5.74011 10.7401 5.71344C12.0467 5.60011 13.2134 6.57344 13.3267 7.89344Z"
        fill="currentColor"
      />
      <path
        d="M14.66 14.0599C14.6067 14.7066 14.1933 15.2666 13.5 15.6466C12.8333 16.0133 11.9933 16.1866 11.16 16.1666C11.64 15.7333 11.92 15.1933 11.9733 14.6199C12.04 13.7933 11.6467 12.9999 10.86 12.3666C10.4133 12.0133 9.89333 11.7333 9.32666 11.5266C10.8 11.0999 12.6533 11.3866 13.7933 12.3066C14.4067 12.7999 14.72 13.4199 14.66 14.0599Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function MoreIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <circle cx="5" cy="12" r="1.75" fill="currentColor" />
      <circle cx="12" cy="12" r="1.75" fill="currentColor" />
      <circle cx="19" cy="12" r="1.75" fill="currentColor" />
    </svg>
  );
}

export function LocationPinIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        d="M12 21s6-5.7 6-11a6 6 0 1 0-12 0c0 5.3 6 11 6 11Zm0-8.25A2.75 2.75 0 1 0 12 7.25a2.75 2.75 0 0 0 0 5.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function ChevronRightIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="m9 5 7 7-7 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CalendarPlusIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M7 3v3M17 3v3M4 9h16M12 13v6M9 16h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <rect x="4" y="5" width="16" height="15" rx="4" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function InviteIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M14 12a4 4 0 1 0-4 0c-2.5.7-4.5 2.6-5 5.1A1 1 0 0 0 6 18h12a1 1 0 0 0 1-.9c-.5-2.5-2.5-4.4-5-5.1Z" fill="currentColor" />
      <path d="M19 4v5M16.5 6.5H21.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function ChatIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        d="M12 5c-4.97 0-9 3.13-9 7s4.03 7 9 7c.88 0 1.73-.1 2.54-.29L19 21l-1.05-3.52C19.85 16.2 21 14.2 21 12c0-3.87-4.03-7-9-7Z"
        stroke="currentColor"
        strokeWidth="1.9"
        fill="none"
        strokeLinejoin="round"
      />
      <circle cx="9" cy="12" r="1.1" fill="currentColor" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" />
      <circle cx="15" cy="12" r="1.1" fill="currentColor" />
    </svg>
  );
}

export function NewsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M6 5h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8a3 3 0 0 1-3-3V7a2 2 0 0 1 1-2Z" stroke="currentColor" strokeWidth="1.8" fill="none" />
      <path d="M8 10h8M8 13h8M8 16h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function HeartIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M12 20.5 4.7 13.7a4.9 4.9 0 0 1 6.9-6.9L12 7.2l.4-.4a4.9 4.9 0 0 1 6.9 6.9L12 20.5Z" fill="currentColor" />
    </svg>
  );
}

export function ThumbsUpIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none">
      <path
        d="M10.3 9.2 13 3.9c.22-.43.69-.68 1.17-.61.63.09 1.1.64 1.1 1.27v3.61h3.07c1.28 0 2.15 1.29 1.66 2.47l-1.92 4.58a2.6 2.6 0 0 1-2.4 1.6H10.3"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6 9.3h2.8a1 1 0 0 1 1 1V17a1 1 0 0 1-1 1H6.8A1.8 1.8 0 0 1 5 16.2v-5.1A1.8 1.8 0 0 1 6.8 9.3H6Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function ThumbsDownIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none">
      <path
        d="m10.3 14.8 2.7 5.3c.22.43.69.68 1.17.61.63-.09 1.1-.64 1.1-1.27v-3.61h3.07c1.28 0 2.15-1.29 1.66-2.47l-1.92-4.58a2.6 2.6 0 0 0-2.4-1.6H10.3"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6 14.7h2.8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1H6.8A1.8 1.8 0 0 0 5 7.8v5.1A1.8 1.8 0 0 0 6.8 14.7H6Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function TrophyIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M8 4h8v3a4 4 0 0 1-2.5 3.7V13H15a1 1 0 0 1 0 2H9a1 1 0 0 1 0-2h1.5v-2.3A4 4 0 0 1 8 7V4Z" fill="currentColor" />
      <path d="M6 5H3c0 2.3 1.2 4.1 3 5M18 5h3c0 2.3-1.2 4.1-3 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M8.5 18h7M10 21h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function HomeNavIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 18 18" className={className} aria-hidden="true" fill="none">
      <path
        d="M6.475 1.31049L1.98333 4.81049C1.23333 5.39382 0.625 6.63549 0.625 7.57715V13.7522C0.625 15.6855 2.2 17.2688 4.13333 17.2688H13.7833C15.7167 17.2688 17.2917 15.6855 17.2917 13.7605V7.69382C17.2917 6.68549 16.6167 5.39382 15.7917 4.81882L10.6417 1.21049C9.475 0.39382 7.6 0.435487 6.475 1.31049Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TennisBallIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M8.2 4.4c2.25 1.62 3.55 4.34 3.55 7.6 0 3.26-1.3 5.98-3.55 7.6"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
      />
      <path
        d="M15.8 4.4c-2.25 1.62-3.55 4.34-3.55 7.6 0 3.26 1.3 5.98 3.55 7.6"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function MoonNavIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden="true" fill="none">
      <path
        d="M9.69613 1.6616C9.07113 2.65326 8.72947 3.80326 8.72947 4.9866C8.72947 8.4366 11.5295 11.2366 14.9795 11.2366C16.1628 11.2366 17.3045 10.9033 18.2961 10.2783C18.2878 10.6616 18.2461 11.0533 18.1878 11.4533C17.6045 14.8783 14.8295 17.6366 11.3961 18.2033C5.6878 19.1449 0.821134 14.2783 1.7628 8.56993C2.32947 5.1366 5.0878 2.3616 8.5128 1.77826C8.9128 1.7116 9.3128 1.66993 9.69613 1.6616Z"
        fill="currentColor"
      />
      <path
        d="M11.1582 1.74805C12.9412 1.99852 14.5958 2.81986 15.873 4.08887C17.1502 5.35785 17.9821 7.00686 18.2441 8.78809L18.0293 8.94434C17.1871 9.597 16.1269 9.98535 14.9785 9.98535C12.2202 9.98535 9.97852 7.74368 9.97852 4.98535C9.97852 3.76036 10.4249 2.61471 11.1582 1.74805Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function BubbleNavIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden="true" fill="none">
      <path
        d="M9.99935 19.0079C9.42435 19.0079 8.88268 18.7163 8.49935 18.2079L7.24935 16.5413C7.22435 16.5079 7.12435 16.4663 7.08268 16.4579H6.66602C3.19102 16.4579 1.04102 15.5163 1.04102 10.8329V6.66626C1.04102 2.98293 2.98268 1.04126 6.66602 1.04126H13.3327C17.016 1.04126 18.9577 2.98293 18.9577 6.66626V10.8329C18.9577 14.5163 17.016 16.4579 13.3327 16.4579H12.916C12.8493 16.4579 12.791 16.4913 12.7493 16.5413L11.4993 18.2079C11.116 18.7163 10.5743 19.0079 9.99935 19.0079ZM6.66602 2.29126C3.68268 2.29126 2.29102 3.68293 2.29102 6.66626V10.8329C2.29102 14.5996 3.58268 15.2079 6.66602 15.2079H7.08268C7.50768 15.2079 7.99101 15.4496 8.24935 15.7913L9.49935 17.4579C9.79101 17.8413 10.2077 17.8413 10.4993 17.4579L11.7493 15.7913C12.0243 15.4246 12.4577 15.2079 12.916 15.2079H13.3327C16.316 15.2079 17.7077 13.8163 17.7077 10.8329V6.66626C17.7077 3.68293 16.316 2.29126 13.3327 2.29126H6.66602Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function ProfileNavIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden="true" fill="none">
      <path
        d="M10.1441 9.5C10.0541 9.49098 9.94595 9.49098 9.84685 9.5C7.7027 9.42785 6 7.66911 6 5.50451C6 3.29481 7.78378 1.5 10 1.5C12.2072 1.5 14 3.29481 14 5.50451C13.991 7.66911 12.2883 9.42785 10.1441 9.5Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10.0078 11.625C11.7873 11.625 13.529 12.0325 14.8145 12.8086H14.8154C15.9357 13.4823 16.375 14.2932 16.375 14.9932C16.3749 15.6936 15.9345 16.5061 14.8135 17.1846C13.5226 17.9653 11.7789 18.375 10 18.375C8.22112 18.375 6.47741 17.9653 5.18652 17.1846L5.18457 17.1836C4.06461 16.5099 3.625 15.6998 3.625 15C3.625 14.2996 4.06466 13.486 5.18555 12.8076C6.48212 12.0311 8.22931 11.625 10.0078 11.625Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function FeedNavIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M6 7h12M6 12h9M6 17h7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M18 5a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM18 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM18 15a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z" fill="currentColor" />
    </svg>
  );
}

export function GamesNavIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M8 7h8l3 6-2.5 4h-9L5 13 8 7Z" stroke="currentColor" strokeWidth="1.9" fill="none" strokeLinejoin="round" />
      <path d="M9.2 12h2.6M10.5 10.7v2.6M15.7 11.3h.01M17.5 13.1h.01" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

export function TennisRacketIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none">
      <path
        d="M14.8 4.3a5.7 5.7 0 1 0-8.06 8.06l1.33 1.33a5.7 5.7 0 0 0 8.06-8.06L14.8 4.3Z"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <path d="M9 14.9 5.1 18.8M4.3 19.6l1.8-1.8M6.9 22l2.7-2.7" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M9.2 6.8 14.6 12.2M8.1 9.1h7.5M11.4 5.8v7.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function PeopleIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M7.5 12.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM16.5 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" fill="currentColor" />
      <path d="M4 18c.5-2.3 2.5-4 4.9-4h1.2c2.4 0 4.4 1.7 4.9 4M13.5 18c.35-1.66 1.8-2.9 3.54-2.9h.46c1.74 0 3.19 1.24 3.54 2.9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function PlusIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export function CloseIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M7 7 17 17M17 7 7 17" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export function TableIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none">
      <rect x="4" y="5" width="16" height="14" rx="3" stroke="currentColor" strokeWidth="1.9" />
      <path d="M4.8 10.2h14.4M9.3 5.8v12.4M14.7 5.8v12.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
