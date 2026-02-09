import { describe, it, expect, beforeEach } from 'vitest';
import { resetUpload } from '../../app/static/js/modules/upload-control.js';
import state from '../../app/static/js/modules/state.js';

describe('upload-control', () => {
    beforeEach(() => {
        state.currentJobId = 'test-job';
        state.eventSource = null;
        state.selectedFolderPath = '/some/path';
        state.scanFilePaths = ['/file1.mcap'];
        state.scanFileStatuses = [{ path: '/file1.mcap', filename: 'file1.mcap', size: 100, already_uploaded: false }];
        state.scanTotalSize = 100;
        state.scanFolderPath = '/some/path';
        state.currentStep = 3;

        document.body.innerHTML = `
            <div id="upload-steps">
                <div data-step="1"></div>
                <div class="step-connector"></div>
                <div data-step="2"></div>
                <div class="step-connector"></div>
                <div data-step="3"></div>
                <div class="step-connector"></div>
                <div data-step="4"></div>
            </div>
            <div id="step-description"></div>
            <div id="folder-browser-panel" class="hidden"></div>
            <div id="upload-section"></div>
            <div id="completion-section"></div>
            <div id="scan-results-section"></div>
            <div id="confirm-upload-modal"></div>
        `;
    });

    describe('resetUpload', () => {
        it('clears the job ID', () => {
            resetUpload();
            expect(state.currentJobId).toBeNull();
        });

        it('clears selected folder path', () => {
            resetUpload();
            expect(state.selectedFolderPath).toBeNull();
        });

        it('clears scan file paths', () => {
            resetUpload();
            expect(state.scanFilePaths).toEqual([]);
        });

        it('clears scan file statuses and total size', () => {
            resetUpload();
            expect(state.scanFileStatuses).toEqual([]);
            expect(state.scanTotalSize).toBe(0);
            expect(state.scanFolderPath).toBeNull();
        });

        it('shows folder browser panel and hides other sections', () => {
            resetUpload();

            expect(document.getElementById('folder-browser-panel').classList.contains('hidden')).toBe(false);
            expect(document.getElementById('upload-section').classList.contains('hidden')).toBe(true);
            expect(document.getElementById('completion-section').classList.contains('hidden')).toBe(true);
            expect(document.getElementById('scan-results-section').classList.contains('hidden')).toBe(true);
            expect(document.getElementById('confirm-upload-modal').classList.contains('hidden')).toBe(true);
        });

        it('resets stepper to step 1', () => {
            resetUpload();
            expect(state.currentStep).toBe(1);
        });

        it('closes eventSource if open', () => {
            let closeCalled = false;
            state.eventSource = { close: () => { closeCalled = true; } };
            resetUpload();
            expect(closeCalled).toBe(true);
            expect(state.eventSource).toBeNull();
        });
    });
});
