'use strict';

const { csrfProtection, tokenFor, TOKEN_FIELD } = require('../../middleware/csrf');

function makeReq({ method = 'POST', body = {}, headers = {}, session = {} } = {}) {
  return {
    method,
    body,
    session,
    get: (name) => headers[String(name).toLowerCase()]
  };
}

function makeRes() {
  return { locals: {} };
}

describe('CSRF protection', () => {
  it('issues one secret per session and reuses it', () => {
    const req = makeReq();
    const first = tokenFor(req);
    expect(first).toEqual(expect.any(String));
    expect(tokenFor(req)).toBe(first);
  });

  it('exposes the token to templates on every request', () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();
    csrfProtection()(req, res, () => {});
    expect(res.locals.csrfToken).toBe(req.session.csrfSecret);
  });

  it('lets safe methods through without a token', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const next = jest.fn();
      csrfProtection()(makeReq({ method }), makeRes(), next);
      expect(next).toHaveBeenCalledWith();
    }
  });

  it('rejects a POST with no token', () => {
    const next = jest.fn();
    csrfProtection()(makeReq(), makeRes(), next);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('EBADCSRFTOKEN');
    expect(err.status).toBe(403);
  });

  it('rejects a POST with the wrong token', () => {
    const req = makeReq({ body: { [TOKEN_FIELD]: 'not-the-secret' } });
    tokenFor(req);
    const next = jest.fn();
    csrfProtection()(req, makeRes(), next);
    expect(next.mock.calls[0][0].code).toBe('EBADCSRFTOKEN');
  });

  it('accepts the correct token from the form body', () => {
    const req = makeReq();
    const token = tokenFor(req);
    req.body[TOKEN_FIELD] = token;

    const next = jest.fn();
    csrfProtection()(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('accepts the correct token from the X-CSRF-Token header', () => {
    const session = {};
    const seed = makeReq({ session });
    const token = tokenFor(seed);

    const req = makeReq({ session, headers: { 'x-csrf-token': token } });
    const next = jest.fn();
    csrfProtection()(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('rejects a token of a different length without throwing', () => {
    const req = makeReq();
    tokenFor(req);
    req.body[TOKEN_FIELD] = 'short';
    const next = jest.fn();
    expect(() => csrfProtection()(req, makeRes(), next)).not.toThrow();
    expect(next.mock.calls[0][0].code).toBe('EBADCSRFTOKEN');
  });

  it('honours an exemption predicate', () => {
    const next = jest.fn();
    csrfProtection({ exempt: () => true })(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('does nothing when there is no session at all', () => {
    const next = jest.fn();
    csrfProtection()({ method: 'POST', session: null }, makeRes(), next);
    expect(next).toHaveBeenCalledWith();
  });
});
