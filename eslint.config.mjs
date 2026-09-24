import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';

const boundaries = (patterns) => ['error', { patterns }];
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.angular/**',
      '**/coverage/**',
      'playwright-report/**',
      'test-results/**',
      'result/**',
    ],
  },
  {
    files: ['**/*.ts'],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['apps/web/**/*.ts'],
    extends: [...angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    rules: {
      'no-restricted-imports': boundaries([
        'node:*',
        '@thrallwright/server',
        '**/server/**',
      ]),
    },
  },
  {
    files: ['apps/web/**/*.html'],
    extends: [
      ...angular.configs.templateRecommended,
      ...angular.configs.templateAccessibility,
    ],
  },
  {
    files: ['apps/server/**/*.ts'],
    rules: {
      'no-restricted-imports': boundaries([
        '@angular/*',
        '@thrallwright/web',
        '**/web/**',
      ]),
    },
  },
  {
    files: ['packages/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': boundaries([
        'node:*',
        '@angular/*',
        '@thrallwright/server',
        '@thrallwright/web',
        '**/apps/**',
        '**/server/**',
        '**/web/**',
      ]),
    },
  },
);
