import { describe, it, expect } from 'vitest';
import state from '../../app/static/js/modules/state.js';

describe('state', () => {
    it('has correct default values', () => {
        expect(state.currentJobId).toBeNull();
        expect(state.eventSource).toBeNull();
        expect(state.selectedFolderPath).toBeNull();
        expect(state.currentStep).toBe(1);
        expect(state.currentPrefix).toBe('');
        expect(state.appVersionData).toBeNull();
        expect(state.currentAwsProfile).toBeUndefined();
        expect(state.scanFilePaths).toEqual([]);
        expect(state.scanFileStatuses).toEqual([]);
        expect(state.scanTotalSize).toBe(0);
        expect(state.scanFolderPath).toBeNull();
        expect(state.reviewSortConfig).toEqual({ column: 'filename', ascending: true });
    });

    it('is a shared mutable reference', () => {
        const originalStep = state.currentStep;
        state.currentStep = 3;
        expect(state.currentStep).toBe(3);
        state.currentStep = originalStep;
    });

    it('allows setting and clearing job id', () => {
        state.currentJobId = 'test-job-123';
        expect(state.currentJobId).toBe('test-job-123');
        state.currentJobId = null;
        expect(state.currentJobId).toBeNull();
    });

    it('allows managing scan file paths', () => {
        state.scanFilePaths = ['/path/to/file1.mcap', '/path/to/file2.mcap'];
        expect(state.scanFilePaths).toHaveLength(2);
        state.scanFilePaths = [];
    });
});
