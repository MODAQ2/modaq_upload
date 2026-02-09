import { describe, it, expect, beforeEach, vi } from 'vitest';
import state from '../../app/static/js/modules/state.js';

describe('file-browser', () => {
    beforeEach(() => {
        state.currentPrefix = '';

        document.body.innerHTML = `
            <div id="refresh-btn"></div>
            <input id="search-input" type="text" />
            <div id="retry-btn"></div>
            <div id="close-search-btn"></div>
            <div id="bucket-name">Loading...</div>
            <div id="bucket-status"></div>
            <div id="loading-state" class="hidden"></div>
            <div id="error-state" class="hidden"></div>
            <div id="error-message"></div>
            <div id="empty-state" class="hidden"></div>
            <div id="file-list" class="hidden"></div>
            <nav id="breadcrumb"></nav>
            <div id="search-results" class="hidden"></div>
            <div id="search-results-list"></div>
        `;
    });

    it('state.currentPrefix defaults to empty string', () => {
        expect(state.currentPrefix).toBe('');
    });

    it('currentPrefix can be updated', () => {
        state.currentPrefix = 'year=2024/';
        expect(state.currentPrefix).toBe('year=2024/');
        state.currentPrefix = '';
    });
});
