import { describe, it, expect, beforeEach } from 'vitest';
import { updateProgressUI, showCompletionSummary } from '../../app/static/js/modules/upload-exec.js';
import state from '../../app/static/js/modules/state.js';

describe('upload-exec', () => {
    beforeEach(() => {
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
            <div id="progress-percent"></div>
            <div id="progress-bar" style="width: 0%"></div>
            <div id="files-completed"></div>
            <div id="files-total"></div>
            <div id="bytes-uploaded"></div>
            <div id="bytes-total"></div>
            <div id="eta"></div>
            <div id="upload-section"></div>
            <div id="completion-section" class="hidden"></div>
            <div id="completed-count"></div>
            <div id="skipped-count"></div>
            <div id="failed-count"></div>
            <div id="total-uploaded-size"></div>
            <div id="total-upload-time"></div>
            <div id="avg-upload-speed"></div>
            <div id="avg-file-time"></div>
            <div id="completion-file-list"></div>
        `;
    });

    describe('updateProgressUI', () => {
        it('updates progress elements', () => {
            updateProgressUI({
                progress_percent: 50.5,
                files_completed: 3,
                total_files: 6,
                uploaded_bytes_formatted: '15 MB',
                total_bytes_formatted: '30 MB',
                eta_seconds: 120,
                files: [
                    { filename: 'test.mcap', status: 'completed', file_size_formatted: '5 MB', progress_percent: 100 },
                    { filename: 'test2.mcap', status: 'uploading', file_size_formatted: '5 MB', progress_percent: 50 },
                ],
            });

            expect(document.getElementById('progress-percent').textContent).toBe('50.5');
            expect(document.getElementById('files-completed').textContent).toBe('3');
            expect(document.getElementById('files-total').textContent).toBe('6');
            expect(document.getElementById('bytes-uploaded').textContent).toBe('15 MB');
            expect(document.getElementById('bytes-total').textContent).toBe('30 MB');
            expect(document.getElementById('eta').textContent).toBe('2m 0s');
        });
    });

    describe('showCompletionSummary', () => {
        it('updates completion counts', () => {
            showCompletionSummary({
                files: [
                    { status: 'completed', filename: 'a.mcap', file_size_formatted: '5 MB' },
                    { status: 'completed', filename: 'b.mcap', file_size_formatted: '3 MB' },
                    { status: 'skipped', filename: 'c.mcap', file_size_formatted: '2 MB' },
                    { status: 'failed', filename: 'd.mcap', file_size_formatted: '1 MB' },
                ],
                files_uploaded: 2,
                files_skipped: 1,
                files_failed: 1,
                successfully_uploaded_bytes_formatted: '8 MB',
                total_upload_duration_formatted: '1m 30s',
                average_upload_speed_mbps: 42.5,
            });

            expect(document.getElementById('completed-count').textContent).toBe('2');
            expect(document.getElementById('skipped-count').textContent).toBe('1');
            expect(document.getElementById('failed-count').textContent).toBe('1');
            expect(document.getElementById('total-uploaded-size').textContent).toBe('8 MB');
            expect(document.getElementById('avg-upload-speed').textContent).toBe('42.5 Mbps');
        });

        it('sets step to 4 (complete)', () => {
            showCompletionSummary({
                files: [{ status: 'completed', filename: 'a.mcap', file_size_formatted: '5 MB' }],
            });

            expect(state.currentStep).toBe(4);
        });

        it('shows completion section and hides upload section', () => {
            showCompletionSummary({
                files: [{ status: 'completed', filename: 'a.mcap', file_size_formatted: '5 MB' }],
            });

            expect(document.getElementById('upload-section').classList.contains('hidden')).toBe(true);
            expect(document.getElementById('completion-section').classList.contains('hidden')).toBe(false);
        });
    });
});
