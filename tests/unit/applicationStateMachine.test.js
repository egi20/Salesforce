'use strict';

const Application = require('../../models/Application');

describe('application state machine', () => {
  it('refuses to jump straight to hired', () => {
    expect(Application.canTransition('submitted', 'hired')).toBe(false);
    expect(Application.canTransition('reviewing', 'hired')).toBe(false);
    expect(Application.canTransition('shortlisted', 'hired')).toBe(false);
  });

  it('allows the intended forward path', () => {
    const path = ['submitted', 'reviewing', 'shortlisted', 'interviewing', 'offered', 'hired'];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(Application.canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('allows rejection and withdrawal from every live stage', () => {
    for (const stage of ['submitted', 'reviewing', 'shortlisted', 'interviewing', 'offered']) {
      expect(Application.canTransition(stage, 'rejected')).toBe(true);
      expect(Application.canTransition(stage, 'withdrawn')).toBe(true);
    }
  });

  it('treats hired and rejected as terminal', () => {
    expect(Application.isTerminal('hired')).toBe(true);
    expect(Application.isTerminal('rejected')).toBe(true);
    expect(Application.canTransition('hired', 'rejected')).toBe(false);
    expect(Application.canTransition('rejected', 'submitted')).toBe(false);
  });

  it('lets a withdrawn application be re-submitted', () => {
    expect(Application.isTerminal('withdrawn')).toBe(false);
    expect(Application.canTransition('withdrawn', 'submitted')).toBe(true);
  });

  it('rejects unknown statuses on either side', () => {
    expect(Application.canTransition('nonsense', 'hired')).toBe(false);
    expect(Application.canTransition('submitted', 'nonsense')).toBe(false);
    expect(Application.canTransition(undefined, 'submitted')).toBe(false);
  });
});
