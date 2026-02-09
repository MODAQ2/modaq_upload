import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../app/static/js/modules/state.js';

describe('logs state', () => {
  beforeEach(() => {
    state.logFilters = { date: null, level: null, category: null, search: '' };
    state.logPagination = { offset: 0, limit: 100 };
  });

  it('logFilters defaults are correct', () => {
    expect(state.logFilters.date).toBeNull();
    expect(state.logFilters.level).toBeNull();
    expect(state.logFilters.category).toBeNull();
    expect(state.logFilters.search).toBe('');
  });

  it('logPagination defaults are correct', () => {
    expect(state.logPagination.offset).toBe(0);
    expect(state.logPagination.limit).toBe(100);
  });

  it('logFilters can be updated', () => {
    state.logFilters.date = '2026-02-07';
    state.logFilters.level = 'ERROR';
    state.logFilters.category = 'upload';
    state.logFilters.search = 'test';

    expect(state.logFilters.date).toBe('2026-02-07');
    expect(state.logFilters.level).toBe('ERROR');
    expect(state.logFilters.category).toBe('upload');
    expect(state.logFilters.search).toBe('test');
  });

  it('logPagination offset can be advanced', () => {
    state.logPagination.offset = 100;
    expect(state.logPagination.offset).toBe(100);
  });

  it('logFilters can be reset', () => {
    state.logFilters.level = 'ERROR';
    state.logFilters = { date: null, level: null, category: null, search: '' };
    expect(state.logFilters.level).toBeNull();
  });
});
