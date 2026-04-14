import { describe, expect, it } from 'vitest';

import { DEFAULT_CHAT_PATH_LINKS_CONFIG, parseChatPathLinksConfig } from './chatPathLinks';

describe('chatPathLinks config', () => {
  it('defaults to the canonical workspace prefix', () => {
    expect(DEFAULT_CHAT_PATH_LINKS_CONFIG).toEqual({ prefixes: ['/workspace/'] });
  });

  it('keeps configured prefixes trimmed without requiring a separate workspace shorthand entry', () => {
    expect(
      parseChatPathLinksConfig(JSON.stringify({
        prefixes: ['  /workspace/  ', '  /home/derrick/.openclaw/workspace/  '],
      })),
    ).toEqual({
      prefixes: ['/workspace/', '/home/derrick/.openclaw/workspace/'],
    });
  });

  it('falls back to the canonical workspace prefix when prefixes are missing or empty', () => {
    expect(parseChatPathLinksConfig('{}')).toEqual({ prefixes: ['/workspace/'] });
    expect(parseChatPathLinksConfig(JSON.stringify({ prefixes: [] }))).toEqual({ prefixes: ['/workspace/'] });
    expect(parseChatPathLinksConfig(JSON.stringify({ prefixes: ['   '] }))).toEqual({ prefixes: ['/workspace/'] });
  });
});
