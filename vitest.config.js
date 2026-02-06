import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        include: ['tests/js/**/*.test.js'],
        coverage: {
            provider: 'v8',
            include: ['app/static/js/**/*.js'],
            reportsDirectory: 'htmlcov-js',
        },
    },
});
