import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { showNotification } from '../../app/static/js/modules/notify.js';
import { formatBytes, formatEta, formatDuration } from '../../app/static/js/modules/formatters.js';

describe('formatBytes', () => {
    it('returns "0 B" for zero bytes', () => {
        expect(formatBytes(0)).toBe('0 B');
    });

    it('formats bytes correctly', () => {
        expect(formatBytes(500)).toBe('500 B');
    });

    it('formats kilobytes', () => {
        expect(formatBytes(1024)).toBe('1 KB');
        expect(formatBytes(1536)).toBe('1.5 KB');
    });

    it('formats megabytes', () => {
        expect(formatBytes(1048576)).toBe('1 MB');
        expect(formatBytes(1572864)).toBe('1.5 MB');
    });

    it('formats gigabytes', () => {
        expect(formatBytes(1073741824)).toBe('1 GB');
    });

    it('formats terabytes', () => {
        expect(formatBytes(1099511627776)).toBe('1 TB');
    });
});

describe('formatEta', () => {
    it('returns "Calculating..." for null/undefined', () => {
        expect(formatEta(null)).toBe('Calculating...');
        expect(formatEta(undefined)).toBe('Calculating...');
    });

    it('returns "Calculating..." for negative values', () => {
        expect(formatEta(-5)).toBe('Calculating...');
    });

    it('formats seconds', () => {
        expect(formatEta(30)).toBe('30s');
        expect(formatEta(1)).toBe('1s');
    });

    it('formats minutes and seconds', () => {
        expect(formatEta(90)).toBe('1m 30s');
        expect(formatEta(125)).toBe('2m 5s');
    });

    it('formats hours and minutes', () => {
        expect(formatEta(3661)).toBe('1h 1m');
        expect(formatEta(7200)).toBe('2h 0m');
    });
});

describe('formatDuration', () => {
    it('formats sub-second durations as milliseconds', () => {
        expect(formatDuration(0.5)).toBe('500ms');
        expect(formatDuration(0.001)).toBe('1ms');
    });

    it('formats seconds with one decimal', () => {
        expect(formatDuration(5.3)).toBe('5.3s');
        expect(formatDuration(30.0)).toBe('30.0s');
    });

    it('formats minutes and seconds', () => {
        expect(formatDuration(90)).toBe('1m 30s');
        expect(formatDuration(125)).toBe('2m 5s');
    });
});

describe('showNotification', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('creates a notification element in the DOM', () => {
        showNotification('Test message', 'info');
        const notification = document.querySelector('.fixed.top-4.right-4');
        expect(notification).not.toBeNull();
        expect(notification.textContent).toBe('Test message');
    });

    it('applies error styling for error type', () => {
        showNotification('Error!', 'error');
        const notification = document.querySelector('.fixed.top-4.right-4');
        expect(notification.classList.contains('bg-red-500')).toBe(true);
    });

    it('applies success styling for success type', () => {
        showNotification('Success!', 'success');
        const notification = document.querySelector('.fixed.top-4.right-4');
        expect(notification.classList.contains('bg-green-500')).toBe(true);
    });

    it('applies info styling by default', () => {
        showNotification('Info');
        const notification = document.querySelector('.fixed.top-4.right-4');
        expect(notification.classList.contains('bg-nlr-blue')).toBe(true);
    });
});
