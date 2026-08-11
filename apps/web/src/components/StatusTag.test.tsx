// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusTag } from './StatusTag';

describe('StatusTag', () => {
  it('uses the agreed Chinese call result labels', () => {
    const { rerender } = render(<StatusTag status="CONNECTED" />);
    expect(screen.getByText('已接通')).toBeInTheDocument();
    rerender(<StatusTag status="UNKNOWN" />);
    expect(screen.getByText('未知')).toBeInTheDocument();
  });
});
