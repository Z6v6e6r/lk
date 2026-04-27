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

export function GameLocationIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 12 12" className={className} aria-hidden="true" fill="none">
      <path
        d="M10.3081 4.22421C9.78322 1.91459 7.76855 0.874756 5.99884 0.874756C5.99884 0.874756 5.99884 0.874756 5.99384 0.874756C4.22912 0.874756 2.20945 1.90959 1.68454 4.21921C1.09963 6.79879 2.67938 8.98344 4.10914 10.3582C4.63906 10.8681 5.31895 11.1231 5.99884 11.1231C6.67873 11.1231 7.35862 10.8681 7.88353 10.3582C9.3133 8.98344 10.893 6.80379 10.3081 4.22421ZM5.99884 6.7288C5.12898 6.7288 4.42409 6.02392 4.42409 5.15406C4.42409 4.2842 5.12898 3.57932 5.99884 3.57932C6.8687 3.57932 7.57358 4.2842 7.57358 5.15406C7.57358 6.02392 6.8687 6.7288 5.99884 6.7288Z"
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

export function GameDateIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 12 12" className={className} aria-hidden="true" fill="none">
      <path
        d="M8.63881 1H7.80547H4.19436L3.36102 0.999928C1.86102 1.13882 1.13324 2.06667 1.02213 3.39445C1.01102 3.55556 1.14435 3.68889 1.29991 3.68889H10.6999C10.861 3.68889 10.9944 3.55 10.9777 3.39445C10.8666 2.06667 10.1388 1.13889 8.63881 1Z"
        fill="currentColor"
      />
      <path
        d="M10.4445 4.24438H1.55556C1.25 4.24438 1 4.49438 1 4.79994V8.22217C1 9.88883 1.83333 10.9999 3.77778 10.9999H8.22223C10.1667 10.9999 11 9.88883 11 8.22217V4.79994C11 4.49438 10.75 4.24438 10.4445 4.24438ZM4.45 8.89439C4.42223 8.91661 4.39445 8.94439 4.36667 8.96106C4.33334 8.98328 4.3 8.99994 4.26667 9.01106C4.23334 9.02772 4.2 9.03883 4.16667 9.04439C4.12778 9.04994 4.09445 9.0555 4.05556 9.0555C3.98334 9.0555 3.91111 9.03883 3.84445 9.01106C3.77222 8.98328 3.71667 8.94439 3.66111 8.89439C3.56111 8.78883 3.5 8.64439 3.5 8.49994C3.5 8.3555 3.56111 8.21106 3.66111 8.1055C3.71667 8.0555 3.77222 8.01661 3.84445 7.98883C3.94445 7.94439 4.05556 7.93328 4.16667 7.9555C4.2 7.96106 4.23334 7.97217 4.26667 7.98883C4.3 7.99994 4.33334 8.01661 4.36667 8.03883C4.39445 8.06105 4.42223 8.08328 4.45 8.1055C4.55 8.21106 4.61111 8.3555 4.61111 8.49994C4.61111 8.64439 4.55 8.78883 4.45 8.89439ZM4.45 6.94994C4.34445 7.04994 4.2 7.11105 4.05556 7.11105C3.91111 7.11105 3.76667 7.04994 3.66111 6.94994C3.56111 6.84439 3.5 6.69994 3.5 6.5555C3.5 6.41105 3.56111 6.26661 3.66111 6.16105C3.81667 6.0055 4.06111 5.9555 4.26667 6.04439C4.33889 6.07216 4.4 6.11105 4.45 6.16105C4.55 6.26661 4.61111 6.41105 4.61111 6.5555C4.61111 6.69994 4.55 6.84439 4.45 6.94994ZM6.39445 8.89439C6.28889 8.99439 6.14445 9.0555 6 9.0555C5.85556 9.0555 5.71112 8.99439 5.60556 8.89439C5.50556 8.78883 5.44445 8.64439 5.44445 8.49994C5.44445 8.3555 5.50556 8.21106 5.60556 8.1055C5.81112 7.89994 6.18889 7.89994 6.39445 8.1055C6.49445 8.21106 6.55556 8.3555 6.55556 8.49994C6.55556 8.64439 6.49445 8.78883 6.39445 8.89439ZM6.39445 6.94994C6.36667 6.97216 6.33889 6.99439 6.31112 7.01661C6.27778 7.03883 6.24445 7.0555 6.21112 7.06661C6.17778 7.08328 6.14445 7.09439 6.11112 7.09994C6.07223 7.1055 6.03889 7.11105 6 7.11105C5.85556 7.11105 5.71112 7.04994 5.60556 6.94994C5.50556 6.84439 5.44445 6.69994 5.44445 6.5555C5.44445 6.41105 5.50556 6.26661 5.60556 6.16105C5.65556 6.11105 5.71667 6.07216 5.78889 6.04439C5.99445 5.9555 6.23889 6.0055 6.39445 6.16105C6.49445 6.26661 6.55556 6.41105 6.55556 6.5555C6.55556 6.69994 6.49445 6.84439 6.39445 6.94994ZM8.33889 6.94994C8.31112 6.97216 8.28334 6.99439 8.25556 7.01661C8.22223 7.03883 8.1889 7.0555 8.15556 7.06661C8.12223 7.08328 8.0889 7.09439 8.05556 7.09994C8.01667 7.1055 7.97778 7.11105 7.94445 7.11105C7.80001 7.11105 7.65556 7.04994 7.55001 6.94994C7.45001 6.84439 7.38889 6.69994 7.38889 6.5555C7.38889 6.41105 7.45001 6.26661 7.55001 6.16105C7.60556 6.11105 7.66112 6.07216 7.73334 6.04439C7.83334 5.99994 7.94445 5.98883 8.05556 6.01105C8.0889 6.01661 8.12223 6.02772 8.15556 6.04439C8.1889 6.0555 8.22223 6.07216 8.25556 6.09439C8.28334 6.11661 8.31112 6.13883 8.33889 6.16105C8.4389 6.26661 8.50001 6.41105 8.50001 6.5555C8.50001 6.69994 8.4389 6.84439 8.33889 6.94994Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function EmptySlotAvatarIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 35 35" className={className} aria-hidden="true" fill="none">
      <rect x="0.75" y="0.75" width="33.5" height="33.5" rx="16.75" fill="#F1F1F1" stroke="#FAFAFA" strokeWidth="1.5" />
      <path d="M16.1667 17.9436H13.9444C13.699 17.9436 13.5 17.7446 13.5 17.4991C13.5 17.2537 13.699 17.0547 13.9444 17.0547H16.1667V17.9436Z" fill="#888889" />
      <path d="M21.0556 17.0547C21.301 17.0547 21.5 17.2537 21.5 17.4991C21.5 17.7446 21.301 17.9436 21.0556 17.9436H17.0556V17.0547H21.0556Z" fill="#888889" />
      <path d="M17.9455 21.0536C17.9455 21.2991 17.7465 21.498 17.5011 21.498C17.2556 21.498 17.0566 21.2991 17.0566 21.0536V17.0536H17.9455V21.0536Z" fill="#888889" />
      <path d="M17.5011 13.498C17.7465 13.498 17.9455 13.697 17.9455 13.9425V16.1647H17.0566V13.9425C17.0566 13.697 17.2556 13.498 17.5011 13.498Z" fill="#888889" />
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
    <svg viewBox="0 0 20 20" className={className} aria-hidden="true" fill="none">
      <path
        d="M7.5165 2.36664L3.02484 5.86664C2.27484 6.44997 1.6665 7.69164 1.6665 8.63331V14.8083C1.6665 16.7416 3.2415 18.325 5.17484 18.325H14.8248C16.7582 18.325 18.3332 16.7416 18.3332 14.8166V8.74997C18.3332 7.74164 17.6582 6.44997 16.8332 5.87497L11.6832 2.26664C10.5165 1.44997 8.6415 1.49164 7.5165 2.36664Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 14.9916V11.4995"
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

export function GameLevelIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 12 12" className={className} aria-hidden="true" fill="none">
      <path
        d="M6.55664 3.24951C6.93865 3.24951 7.25195 3.5576 7.25195 3.83643V9.66162C7.2517 9.94036 6.9385 10.2505 6.55664 10.2505H5.44531C5.06365 10.2503 4.75122 9.94026 4.75098 9.66162V3.83643C4.75098 3.5577 5.06349 3.24973 5.44531 3.24951H6.55664ZM10.0566 1.74951C10.4386 1.74951 10.751 2.06236 10.751 2.3374V9.64209C10.751 9.91713 10.4386 10.2505 10.0566 10.2505H8.94531C8.56335 10.2504 8.251 9.91711 8.25098 9.64209V2.3374C8.25098 2.06237 8.56334 1.74955 8.94531 1.74951H10.0566ZM3.05566 4.74951C3.43752 4.74951 3.74977 5.09234 3.75 5.38232V9.63037C3.75 9.91525 3.43766 10.2495 3.05566 10.2495H1.94434C1.56246 10.2494 1.25 9.91518 1.25 9.63037V5.38232C1.25023 5.09757 1.5626 4.74966 1.94434 4.74951H3.05566Z"
        fill="currentColor"
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

export function NavFabPlusIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 88 72" className={className} aria-hidden="true" fill="none">
      <g filter="url(#community-nav-fab-shadow)">
        <rect x="16" y="16" width="56" height="40" rx="16" fill="#8766EB" />
        <path d="M41.75 36.75H38C37.5858 36.75 37.25 36.4142 37.25 36C37.25 35.5858 37.5858 35.25 38 35.25H41.75V36.75Z" fill="#FAFAFA" />
        <path d="M50 35.25C50.4142 35.25 50.75 35.5858 50.75 36C50.75 36.4142 50.4142 36.75 50 36.75H43.25V35.25H50Z" fill="#FAFAFA" />
        <path d="M44.75 42C44.75 42.4142 44.4142 42.75 44 42.75C43.5858 42.75 43.25 42.4142 43.25 42V35.25H44.75V42Z" fill="#FAFAFA" />
        <path d="M44 29.25C44.4142 29.25 44.75 29.5858 44.75 30V33.75H43.25V30C43.25 29.5858 43.5858 29.25 44 29.25Z" fill="#FAFAFA" />
      </g>
      <defs>
        <filter id="community-nav-fab-shadow" x="0" y="0" width="88" height="72" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" />
          <feOffset />
          <feGaussianBlur stdDeviation="8" />
          <feColorMatrix type="matrix" values="0 0 0 0 0.658824 0 0 0 0 0.556863 0 0 0 0 0.964706 0 0 0 0.16 0" />
          <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_160_2543" />
          <feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow_160_2543" result="shape" />
        </filter>
      </defs>
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
