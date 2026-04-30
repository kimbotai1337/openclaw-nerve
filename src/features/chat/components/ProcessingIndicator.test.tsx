import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProcessingIndicator } from './ProcessingIndicator';
import type { ActivityLogEntry } from '@/contexts/ChatContext';

const toolActivity: ActivityLogEntry[] = [
  {
    id: 'tool-1',
    toolName: 'exec',
    description: 'exec: pwd',
    startedAt: 1,
    completedAt: 2,
    phase: 'completed',
  },
];

describe('ProcessingIndicator', () => {
  it('does not show transcript recovery copy while the live tool feed is visible', () => {
    render(
      <ProcessingIndicator
        stage="tool_use"
        elapsedMs={1200}
        lastEventTimestamp={Date.now()}
        currentToolDescription="exec: pwd"
        activityLog={toolActivity}
        isRecovering
        recoveryReason="chat-gap"
      />,
    );

    expect(screen.getAllByText('exec: pwd')).not.toHaveLength(0);
    expect(screen.queryByText(/Resyncing transcript/)).not.toBeInTheDocument();
  });

  it('shows transcript recovery copy when no live tool feed would be displaced', () => {
    render(
      <ProcessingIndicator
        stage="thinking"
        elapsedMs={1200}
        lastEventTimestamp={Date.now()}
        currentToolDescription={null}
        activityLog={[]}
        isRecovering
        recoveryReason="reconnect"
      />,
    );

    expect(screen.getByText(/Resyncing transcript/)).toBeInTheDocument();
  });
});
