import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../app/static/js/modules/state.js';

describe('settings', () => {
    beforeEach(() => {
        state.currentAwsProfile = undefined;
    });

    it('state.currentAwsProfile defaults to undefined', () => {
        expect(state.currentAwsProfile).toBeUndefined();
    });

    it('state.currentAwsProfile can be set', () => {
        state.currentAwsProfile = 'my-profile';
        expect(state.currentAwsProfile).toBe('my-profile');
        state.currentAwsProfile = undefined;
    });
});
