import React from 'react';

const TRAILING_PUNCTUATION_RE = /[.,:;!?]+$/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const FILE_WORKSPACE_PREFIX = 'file:///workspace/';
const WRAPPER_PAIRS: Array<{ opener: string; closer: string }> = [
  { opener: '`', closer: '`' },
  { opener: "'", closer: "'" },
  { opener: '"', closer: '"' },
  { opener: '<', closer: '>' },
];

function stripTrailingPunctuation(token: string): { core: string; trailing: string } {
  const trailing = token.match(TRAILING_PUNCTUATION_RE)?.[0] ?? '';
  return {
    core: trailing ? token.slice(0, -trailing.length) : token,
    trailing,
  };
}

function findConfiguredPrefixMatch(
  value: string,
  prefixes: string[],
): { index: number; prefix: string } | null {
  let bestMatch: { index: number; prefix: string } | null = null;

  for (const prefix of prefixes) {
    const index = value.indexOf(prefix);
    if (index < 0) continue;
    if (!bestMatch || index < bestMatch.index || (index === bestMatch.index && prefix.length > bestMatch.prefix.length)) {
      bestMatch = { index, prefix };
    }
  }

  return bestMatch;
}

function extractWrappedPathSlice(
  core: string,
  prefixes: string[],
): { before: string; display: string; candidate: string; after: string } | null {
  for (const { opener, closer } of WRAPPER_PAIRS) {
    if (!core.startsWith(opener) || !core.endsWith(closer)) continue;

    const inner = core.slice(opener.length, core.length - closer.length);

    if (inner.startsWith(FILE_WORKSPACE_PREFIX)) {
      const candidate = inner.slice('file://'.length);
      if (candidate.length <= '/workspace/'.length) return null;
      return {
        before: '',
        display: core,
        candidate,
        after: '',
      };
    }

    const innerMatch = findConfiguredPrefixMatch(inner, prefixes);
    if (!innerMatch) continue;

    const candidate = inner.slice(innerMatch.index);
    if (candidate.length <= innerMatch.prefix.length) return null;
    if (innerMatch.index !== 0) return null;

    return {
      before: '',
      display: core,
      candidate,
      after: '',
    };
  }

  return null;
}

function findConfiguredPathSlice(
  token: string,
  prefixes: string[],
): { before: string; display: string; candidate: string; after: string } | null {
  if (!token) return null;
  if (token.startsWith('//')) return null;

  const { core, trailing } = stripTrailingPunctuation(token);
  if (!core) return null;

  if (core.startsWith(FILE_WORKSPACE_PREFIX)) {
    const candidate = core.slice('file://'.length);
    if (candidate.length <= '/workspace/'.length) return null;
    return { before: '', display: core, candidate, after: trailing };
  }

  const wrapped = extractWrappedPathSlice(core, prefixes);
  if (wrapped) {
    return {
      ...wrapped,
      after: `${wrapped.after}${trailing}`,
    };
  }

  if (SCHEME_RE.test(core)) return null;

  const bestMatch = findConfiguredPrefixMatch(core, prefixes);
  if (!bestMatch) return null;

  const before = core.slice(0, bestMatch.index);
  const candidate = core.slice(bestMatch.index);

  if (candidate.length <= bestMatch.prefix.length) return null;

  return { before, display: candidate, candidate, after: trailing };
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
    const { before, display, candidate, after } = pathSlice;

    return (
      <React.Fragment key={`path-${index}-${display}-${candidate}-${before}-${after}`}>
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
          {display}
        </a>
        {after ? renderPlainText(after) : null}
      </React.Fragment>
    );
  });

  return hasLink ? rendered : renderPlainText(text);
}
