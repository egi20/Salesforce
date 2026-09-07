'use strict';

const { paginationFrom, paginationMeta, pageUrl, MAX_PER_PAGE } = require('../../utils/pagination');

describe('paginationFrom', () => {
  it('defaults sensibly', () => {
    expect(paginationFrom({})).toMatchObject({ page: 1, perPage: 20, offset: 0 });
  });

  it('clamps per_page so a crafted value cannot turn a list into a table scan', () => {
    expect(paginationFrom({ per_page: '100000' }).perPage).toBe(MAX_PER_PAGE);
    expect(paginationFrom({ per_page: '-5' }).perPage).toBe(20);
    expect(paginationFrom({ per_page: 'abc' }).perPage).toBe(20);
  });

  it('clamps page and rejects non-positive values', () => {
    expect(paginationFrom({ page: '0' }).page).toBe(1);
    expect(paginationFrom({ page: '-3' }).page).toBe(1);
    expect(paginationFrom({ page: '999999' }).page).toBe(10000);
  });

  it('computes the offset from page and per_page', () => {
    expect(paginationFrom({ page: '3', per_page: '10' }).offset).toBe(20);
  });
});

describe('paginationMeta', () => {
  it('describes a middle page', () => {
    expect(paginationMeta({ page: 2, perPage: 10, total: 35 })).toMatchObject({
      totalPages: 4, hasPrev: true, hasNext: true, from: 11, to: 20
    });
  });

  it('handles an empty result set without claiming a row range', () => {
    expect(paginationMeta({ page: 1, perPage: 10, total: 0 })).toMatchObject({
      totalPages: 1, hasPrev: false, hasNext: false, from: 0, to: 0
    });
  });

  it('does not overrun the total on the last page', () => {
    expect(paginationMeta({ page: 4, perPage: 10, total: 35 }).to).toBe(35);
  });
});

describe('pageUrl', () => {
  it('preserves the other filters', () => {
    expect(pageUrl('/jobs', { role: 'apex-developer', page: '2' }, 3)).toBe('/jobs?role=apex-developer&page=3');
  });

  it('omits page=1 so the first page has one canonical URL', () => {
    expect(pageUrl('/jobs', { role: 'apex-developer', page: '5' }, 1)).toBe('/jobs?role=apex-developer');
  });

  it('drops empty values and keeps repeated ones', () => {
    expect(pageUrl('/jobs', { role: '', skill: ['a', 'b'] }, 1)).toBe('/jobs?skill=a&skill=b');
  });

  it('returns the bare path when there is nothing to carry', () => {
    expect(pageUrl('/jobs', {}, 1)).toBe('/jobs');
  });
});
