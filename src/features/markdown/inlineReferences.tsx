import React from 'react';

const TRAILING_WRAP_RE = /[)\]}"'.,:;!?]+$/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

function findConfiguredPathSlice(
  token: string,
  prefixes: string[],
): { before: string; candidate: string; after: string } | null {
  if (!token) return null;
  if (SCHEME_RE.test(token) || token.startsWith('//')) return null;

  let bestMatch: { index: number; prefix: string } | null = null;

  prefixes.forEach((prefix) => {
    const index = token.indexOf(prefix);
    if (index < 0) return;
    if (!bestMatch || index < bestMatch.index || (index === bestMatch.index && prefix.length > bestMatch.prefix.length)) {
      bestMatch = { index, prefix };
    }
  });

  if (!bestMatch) return null;

  const before = token.slice(0, bestMatch.index);
  const fromPrefix = token.slice(bestMatch.index);
  const trailing = fromPrefix.match(TRAILING_WRAP_RE)?.[0] ?? '';
  const candidate = trailing ? fromPrefix.slice(0, -trailing.length) : fromPrefix;
  const after = trailing ? token.slice(bestMatch.index + candidate.length) : '';

  if (candidate.length <= bestMatch.prefix.length) return null;

  return { before, candidate, after };
}

export function renderInlinePathReferences(
  text: string,
  options: {
    prefixes?: string[];
    onOpenPath?: (path: string) => void | Promise<void>;
    renderPlainText?: (text: string) => React.ReactNode;
  } = {},
): React.ReactNode {
  const { prefixes = [], onOpenPath, renderPlainText = (value: string) => value } = options;
  if (!text || prefixes.length === 0 || !onOpenPath) {
    return renderPlainText(text);
  }

  const tokens = text.split(/(\s+)/);
  let hasLink = false;

  const rendered = tokens.map((token, index) => {
    if (!token) return null;
    if (/^\s+$/.test(token)) {
      return <React.Fragment key={`ws-${index}-${token}`}>{renderPlainText(token)}</React.Fragment>;
    }

    const pathSlice = findConfiguredPathSlice(token, prefixes);
    if (!pathSlice) {
      return <React.Fragment key={`txt-${index}-${token}`}>{renderPlainText(token)}</React.Fragment>;
    }

    hasLink = true;
    const { before, candidate, after } = pathSlice;

    return (
      <React.Fragment key={`path-${index}-${candidate}-${before}-${after}`}>
        {before ? renderPlainText(before) : null}
        <a
          href={candidate}
          className="markdown-link"
          onClick={(event) => {
            event.preventDefault();
            Promise.resolve(onOpenPath(candidate)).catch((error) => {
              console.error('Failed to open workspace path link:', error);
            });
          }}
        >
          {candidate}
        </a>
        {after ? renderPlainText(after) : null}
      </React.Fragment>
    );
  });

  return hasLink ? rendered : renderPlainText(text);
}
