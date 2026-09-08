'use strict';

const Conversation = require('../../models/Conversation');

describe('conversation subject keys', () => {
  it('keys an application thread by the application', () => {
    expect(Conversation.dedupeKeyFor('application', { applicationId: 42 })).toBe('application:42');
  });

  it('refuses an application thread with no application', () => {
    expect(() => Conversation.dedupeKeyFor('application', {})).toThrow(/needs an applicationId/);
  });

  it('produces the same enquiry key whichever side starts it', () => {
    const a = Conversation.dedupeKeyFor('enquiry', { jobId: 7, userIds: [9, 3] });
    const b = Conversation.dedupeKeyFor('enquiry', { jobId: 7, userIds: [3, 9] });
    expect(a).toBe(b);
    expect(a).toBe('enquiry:7:3:9');
  });

  it('separates enquiries about different roles between the same two people', () => {
    const aboutSeven = Conversation.dedupeKeyFor('enquiry', { jobId: 7, userIds: [3, 9] });
    const aboutEight = Conversation.dedupeKeyFor('enquiry', { jobId: 8, userIds: [3, 9] });
    expect(aboutSeven).not.toBe(aboutEight);
  });

  it('refuses an enquiry that is not between exactly two people', () => {
    expect(() => Conversation.dedupeKeyFor('enquiry', { userIds: [3] })).toThrow(/exactly two/);
    expect(() => Conversation.dedupeKeyFor('enquiry', { userIds: [1, 2, 3] })).toThrow(/exactly two/);
    expect(() => Conversation.dedupeKeyFor('enquiry', { userIds: [] })).toThrow(/exactly two/);
  });

  it('ignores non-integer ids rather than building a key from them', () => {
    expect(() => Conversation.dedupeKeyFor('enquiry', { userIds: ['abc', 3] })).toThrow(/exactly two/);
  });

  it('rejects an unknown kind', () => {
    expect(() => Conversation.dedupeKeyFor('broadcast', {})).toThrow(/Unknown conversation kind/);
  });

  it('stays within the unique index width for plausible ids', () => {
    const key = Conversation.dedupeKeyFor('enquiry', { jobId: 4294967295, userIds: [4294967295, 4294967294] });
    expect(key.length).toBeLessThanOrEqual(190);
  });
});

describe('message body normalisation', () => {
  it('trims and normalises line endings', () => {
    expect(Conversation.normaliseBody('  hello\r\nthere  ')).toBe('hello\nthere');
  });

  it('treats whitespace-only as empty, so it can be rejected', () => {
    expect(Conversation.normaliseBody('   \n\t ')).toBe('');
    expect(Conversation.normaliseBody('')).toBe('');
    expect(Conversation.normaliseBody(null)).toBe('');
    expect(Conversation.normaliseBody(undefined)).toBe('');
  });

  it('caps the length rather than rejecting a long paste outright', () => {
    const long = 'x'.repeat(Conversation.MAX_BODY_LENGTH + 500);
    expect(Conversation.normaliseBody(long)).toHaveLength(Conversation.MAX_BODY_LENGTH);
  });

  it('preserves the text as typed — markup is escaped at render, not stripped here', () => {
    // Bodies are rendered with <%= %>, so storing the raw characters is correct and the
    // escaping happens once, at the boundary.
    expect(Conversation.normaliseBody('<b>hi</b> & bye')).toBe('<b>hi</b> & bye');
  });
});
