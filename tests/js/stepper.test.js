import { describe, it, expect, beforeEach } from 'vitest';
import { setUploadStep, showUploadSteps, hideUploadSteps, goToStep } from '../../app/static/js/modules/stepper.js';
import state from '../../app/static/js/modules/state.js';

describe('stepper', () => {
    beforeEach(() => {
        state.currentStep = 1;

        document.body.innerHTML = `
            <div id="upload-steps">
                <div data-step="1" class=""><div class="step-circle"></div><span class="step-label"></span></div>
                <div class="step-connector"></div>
                <div data-step="2" class=""><div class="step-circle"></div><span class="step-label"></span></div>
                <div class="step-connector"></div>
                <div data-step="3" class=""><div class="step-circle"></div><span class="step-label"></span></div>
                <div class="step-connector"></div>
                <div data-step="4" class=""><div class="step-circle"></div><span class="step-label"></span></div>
            </div>
            <div id="step-description"></div>
        `;
    });

    describe('setUploadStep', () => {
        it('sets the active step', () => {
            setUploadStep(3);

            const step3 = document.querySelector('[data-step="3"]');
            expect(step3.classList.contains('active')).toBe(true);
            expect(step3.classList.contains('completed')).toBe(false);
        });

        it('marks previous steps as completed', () => {
            setUploadStep(3);

            const step1 = document.querySelector('[data-step="1"]');
            const step2 = document.querySelector('[data-step="2"]');
            expect(step1.classList.contains('completed')).toBe(true);
            expect(step2.classList.contains('completed')).toBe(true);
        });

        it('leaves future steps unmarked', () => {
            setUploadStep(3);

            const step4 = document.querySelector('[data-step="4"]');
            expect(step4.classList.contains('active')).toBe(false);
            expect(step4.classList.contains('completed')).toBe(false);
        });

        it('updates the step description', () => {
            setUploadStep(1);
            const desc = document.getElementById('step-description');
            expect(desc.textContent).toBe('Select files or a folder to upload');
        });

        it('updates state.currentStep', () => {
            setUploadStep(4);
            expect(state.currentStep).toBe(4);
        });

        it('colors connectors for completed steps', () => {
            setUploadStep(3);
            const connectors = document.querySelectorAll('.step-connector');
            expect(connectors[0].style.backgroundColor).toBe('rgb(93, 151, 50)');
            expect(connectors[1].style.backgroundColor).toBe('rgb(93, 151, 50)');
            expect(connectors[2].style.backgroundColor).toBe('rgb(209, 213, 219)');
        });
    });

    describe('showUploadSteps', () => {
        it('delegates to setUploadStep', () => {
            showUploadSteps(2);
            expect(state.currentStep).toBe(2);
            const step2 = document.querySelector('[data-step="2"]');
            expect(step2.classList.contains('active')).toBe(true);
        });
    });

    describe('hideUploadSteps', () => {
        it('resets to step 1', () => {
            setUploadStep(4);
            hideUploadSteps();
            expect(state.currentStep).toBe(1);
            const step1 = document.querySelector('[data-step="1"]');
            expect(step1.classList.contains('active')).toBe(true);
        });
    });

    describe('goToStep', () => {
        it('does nothing when navigating forward', async () => {
            state.currentStep = 2;
            await goToStep(3);
            expect(state.currentStep).toBe(2);
        });

        it('does nothing when navigating to current step', async () => {
            state.currentStep = 2;
            await goToStep(2);
            expect(state.currentStep).toBe(2);
        });
    });
});
