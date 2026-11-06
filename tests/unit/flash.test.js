'use strict';

const flash = require('../../middleware/flash');

/*
 * The replacement for connect-flash must behave exactly like it did: every route and the
 * flash partial depend on these four shapes of the call.
 */
function request() {
  const req = { session: {} };
  flash()(req, {}, () => {});
  return req;
}

describe('req.flash', () => {
  test('adds a message and reads it back once', () => {
    const req = request();
    expect(req.flash('success', 'Saved.')).toBe(1);
    expect(req.flash('success', 'Again.')).toBe(2);
    expect(req.flash('success')).toEqual(['Saved.', 'Again.']);
    expect(req.flash('success')).toEqual([]);
  });

  test('adds a list of messages as separate entries', () => {
    const req = request();
    req.flash('error', ['One.', 'Two.']);
    expect(req.flash('error')).toEqual(['One.', 'Two.']);
  });

  test('formats extra arguments like util.format', () => {
    const req = request();
    req.flash('info', 'Estimate %s saved.', 'Q-123');
    expect(req.flash('info')).toEqual(['Estimate Q-123 saved.']);
  });

  test('with no type, returns every type and clears them all', () => {
    const req = request();
    req.flash('success', 'A');
    req.flash('error', 'B');
    expect(req.flash()).toEqual({ success: ['A'], error: ['B'] });
    expect(req.flash()).toEqual({});
  });

  test('refuses to run without a session', () => {
    const req = {};
    flash()(req, {}, () => {});
    expect(() => req.flash('error', 'x')).toThrow('requires sessions');
  });

  test('connect-flash is gone, so nothing calls util.isArray', () => {
    expect(require('../../package.json').dependencies).not.toHaveProperty('connect-flash');
  });
});
