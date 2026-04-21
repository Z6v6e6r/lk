import { tokens } from "./communityTokens";

function buildDataUrl(svg: string) {
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function buildTournamentPlaceholder() {
  return buildDataUrl(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480" fill="none">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#3B235E" />
          <stop offset="52%" stop-color="#7B57F6" />
          <stop offset="100%" stop-color="#1F1239" />
        </linearGradient>
        <radialGradient id="glow" cx="0.5" cy="0.45" r="0.7">
          <stop offset="0%" stop-color="#C5B6FF" stop-opacity="0.95" />
          <stop offset="100%" stop-color="#C5B6FF" stop-opacity="0" />
        </radialGradient>
      </defs>
      <rect width="640" height="480" rx="42" fill="url(#bg)" />
      <rect width="640" height="480" rx="42" fill="url(#glow)" />
      <g opacity="0.22" stroke="#FFF" stroke-width="6" stroke-linecap="round">
        <path d="M56 118h84v42H56" />
        <path d="M56 198h84v42H56" />
        <path d="M56 278h84v42H56" />
        <path d="M56 358h84v42H56" />
        <path d="M140 139h74v80h78" />
        <path d="M140 219h74" />
        <path d="M140 299h74v-80h78" />
        <path d="M140 379h74" />
        <path d="M584 118h-84v42h84" />
        <path d="M584 198h-84v42h84" />
        <path d="M584 278h-84v42h84" />
        <path d="M584 358h-84v42h84" />
        <path d="M500 139h-74v80h-78" />
        <path d="M500 219h-74" />
        <path d="M500 299h-74v-80h-78" />
        <path d="M500 379h-74" />
      </g>
      <g transform="translate(233 112)">
        <path d="M57 9h60c0 29-13 50-40 63v24h34v22H63V72C36 59 23 38 23 9h34v16c0 15 9 28 18 34 10-6 18-19 18-34V9z" fill="#fff"/>
        <path d="M34 118h112v18H34z" fill="#E6DFFF" opacity="0.88"/>
        <path d="M50 144h80v18H50z" fill="#C7B8FF" opacity="0.88"/>
      </g>
    </svg>
  `);
}

function buildNewsPlaceholder() {
  return buildDataUrl(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 600" fill="none">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#D9D6F9" />
          <stop offset="42%" stop-color="#F3D4D2" />
          <stop offset="100%" stop-color="#A3B0E6" />
        </linearGradient>
      </defs>
      <rect width="960" height="600" rx="44" fill="url(#sky)" />
      <rect y="356" width="960" height="244" fill="#7C8899" opacity="0.22" />
      <path d="M110 492h742" stroke="#FDFDFF" stroke-opacity="0.92" stroke-width="8" />
      <path d="M210 286V492" stroke="#2B3458" stroke-width="10" stroke-linecap="round" />
      <path d="M350 246V492" stroke="#2B3458" stroke-width="10" stroke-linecap="round" />
      <path d="M494 214V492" stroke="#2B3458" stroke-width="10" stroke-linecap="round" />
      <path d="M656 236V492" stroke="#2B3458" stroke-width="10" stroke-linecap="round" />
      <path d="M806 264V492" stroke="#2B3458" stroke-width="10" stroke-linecap="round" />
      <rect x="434" y="120" width="96" height="166" rx="12" fill="#596279" opacity="0.45" />
      <rect x="154" y="322" width="666" height="156" rx="16" stroke="#F4F8FF" stroke-width="8" />
      <path d="M154 400h666" stroke="#F4F8FF" stroke-width="7" />
      <circle cx="286" cy="447" r="16" fill="#F8FEFF" />
      <circle cx="654" cy="418" r="20" fill="#F8FEFF" />
    </svg>
  `);
}

function buildAvatarPlaceholder(label: string, start: string, end: string) {
  return buildDataUrl(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" fill="none">
      <defs>
        <linearGradient id="avatar" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${start}" />
          <stop offset="100%" stop-color="${end}" />
        </linearGradient>
      </defs>
      <rect width="120" height="120" rx="60" fill="url(#avatar)" />
      <circle cx="60" cy="44" r="22" fill="#F7F3FF" fill-opacity="0.92" />
      <path d="M28 100c7-20 22-31 32-31s25 11 32 31" fill="#F7F3FF" fill-opacity="0.92" />
      <text x="60" y="112" text-anchor="middle" font-size="16" font-family="Arial, sans-serif" fill="${tokens.purpleDark}" font-weight="700">${label}</text>
    </svg>
  `);
}

export const communityPlaceholderImages = {
  tournament: buildTournamentPlaceholder(),
  news: buildNewsPlaceholder(),
  avatars: {
    al: buildAvatarPlaceholder("AL", "#B8B0FF", "#7B57F6"),
    dn: buildAvatarPlaceholder("DN", "#D0E7FF", "#6E8BFF"),
    ak: buildAvatarPlaceholder("AK", "#FFE0D6", "#FF9B7B"),
    ig: buildAvatarPlaceholder("IG", "#DDF4E6", "#4EBA7A"),
  },
} as const;
