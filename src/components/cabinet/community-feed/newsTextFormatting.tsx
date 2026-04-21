import type { ReactNode } from "react";

const ANCHOR_TAG_PATTERN = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const HREF_ATTR_PATTERN = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const HTML_TAG_PATTERN = /<[^>]*>/g;
const AUTO_LINK_PATTERN = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;
const TRAILING_PUNCTUATION_PATTERN = /[),.;:!?]+$/;
const LINE_BREAK_PATTERN = /\r\n?/g;
const INLINE_WHITESPACE_PATTERN = /[^\S\n]+/g;
const EXTRA_LINE_BREAKS_PATTERN = /\n{3,}/g;
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

function decodeHtmlEntities(value: string) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, code) => {
    const normalized = code.toLowerCase();

    if (normalized === "amp") return "&";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    if (normalized === "quot") return '"';
    if (normalized === "apos" || normalized === "#39") return "'";
    if (normalized === "nbsp") return " ";

    if (normalized.startsWith("#x")) {
      const parsed = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : entity;
    }

    if (normalized.startsWith("#")) {
      const parsed = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : entity;
    }

    return entity;
  });
}

function stripHtmlTags(value: string) {
  return value.replace(HTML_TAG_PATTERN, "");
}

function normalizeTextValue(value: string) {
  return decodeHtmlEntities(stripHtmlTags(value)).replace(/\u00a0/g, " ");
}

function normalizeTextWithLineBreaks(value: string) {
  return value
    .replace(LINE_BREAK_PATTERN, "\n")
    .split("\n")
    .map((line) => line.replace(INLINE_WHITESPACE_PATTERN, " ").trim())
    .join("\n")
    .replace(EXTRA_LINE_BREAKS_PATTERN, "\n\n")
    .trim();
}

function parseHrefAttribute(attrs: string) {
  const match = attrs.match(HREF_ATTR_PATTERN);
  if (!match) return "";
  return decodeHtmlEntities(match[1] || match[2] || match[3] || "").trim();
}

function normalizeLinkTarget(value: string) {
  const compactValue = decodeHtmlEntities(value).trim().replace(/\s+/g, "");
  if (!compactValue) return null;

  if (compactValue.startsWith("www.")) {
    return `https://${compactValue}`;
  }

  if (compactValue.startsWith("//")) {
    return `https:${compactValue}`;
  }

  try {
    const parsed = new URL(compactValue);
    return SAFE_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function splitTrailingPunctuation(value: string) {
  const match = value.match(TRAILING_PUNCTUATION_PATTERN);
  if (!match?.[0]) {
    return { text: value, trailing: "" };
  }

  return {
    text: value.slice(0, -match[0].length),
    trailing: match[0],
  };
}

function appendPlainTextNodes(nodes: ReactNode[], value: string, keyPrefix: string) {
  const text = normalizeTextValue(value);
  if (!text) return;

  let cursor = 0;
  let matchIndex = 0;
  let match: RegExpExecArray | null;

  AUTO_LINK_PATTERN.lastIndex = 0;

  while ((match = AUTO_LINK_PATTERN.exec(text)) !== null) {
    const rawMatch = match[0];
    const startIndex = match.index;

    if (startIndex > cursor) {
      nodes.push(text.slice(cursor, startIndex));
    }

    const { text: visibleUrl, trailing } = splitTrailingPunctuation(rawMatch);
    const href = normalizeLinkTarget(visibleUrl);

    if (href) {
      nodes.push(
        <a
          key={`${keyPrefix}-autolink-${matchIndex}`}
          href={href}
          target="_blank"
          rel="noreferrer"
        >
          {visibleUrl}
        </a>,
      );
    } else {
      nodes.push(visibleUrl);
    }

    if (trailing) {
      nodes.push(trailing);
    }

    cursor = startIndex + rawMatch.length;
    matchIndex += 1;
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
}

function buildAnchorNode(attrs: string, innerHtml: string, key: string) {
  const rawHref = parseHrefAttribute(attrs);
  const labelFromBody = normalizeTextValue(innerHtml).trim();
  const hrefFromAttr = normalizeLinkTarget(rawHref);
  const hrefFromBody = normalizeLinkTarget(labelFromBody);

  const href = hrefFromAttr ?? hrefFromBody;
  if (!href) {
    return labelFromBody || rawHref;
  }

  const label = hrefFromAttr
    ? (labelFromBody || href)
    : (rawHref && !normalizeLinkTarget(rawHref) ? rawHref : labelFromBody || href);

  return (
    <a key={key} href={href} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
}

export function renderNewsTextParagraph(paragraph: string, keyPrefix: string) {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let anchorIndex = 0;
  let match: RegExpExecArray | null;

  ANCHOR_TAG_PATTERN.lastIndex = 0;

  while ((match = ANCHOR_TAG_PATTERN.exec(paragraph)) !== null) {
    const [rawAnchor, attrs = "", innerHtml = ""] = match;
    const startIndex = match.index;

    if (startIndex > cursor) {
      appendPlainTextNodes(nodes, paragraph.slice(cursor, startIndex), `${keyPrefix}-text-${anchorIndex}`);
    }

    const anchorNode = buildAnchorNode(attrs, innerHtml, `${keyPrefix}-anchor-${anchorIndex}`);
    if (anchorNode) {
      nodes.push(anchorNode);
    }

    cursor = startIndex + rawAnchor.length;
    anchorIndex += 1;
  }

  if (cursor < paragraph.length) {
    appendPlainTextNodes(nodes, paragraph.slice(cursor), `${keyPrefix}-tail`);
  }

  return nodes.length > 0 ? nodes : [normalizeTextValue(paragraph)];
}

export function stripNewsTextMarkup(value: string) {
  const withoutAnchors = value.replace(
    ANCHOR_TAG_PATTERN,
    (_rawAnchor, attrs = "", innerHtml = "") => {
      const rawHref = parseHrefAttribute(attrs);
      const bodyText = normalizeTextValue(innerHtml).trim();
      const hrefFromAttr = normalizeLinkTarget(rawHref);
      const hrefFromBody = normalizeLinkTarget(bodyText);

      if (hrefFromAttr) {
        return bodyText || hrefFromAttr;
      }

      if (hrefFromBody) {
        return rawHref && !normalizeLinkTarget(rawHref) ? rawHref : bodyText;
      }

      return bodyText || rawHref;
    },
  );

  return normalizeTextWithLineBreaks(normalizeTextValue(withoutAnchors));
}
