import js from '@eslint/js';
import pluginN from 'eslint-plugin-n';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default [
  // ─── Global ignores ───────────────────────────────────────────────────────
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '.build-exe/**',
      '.pkg-cache/**',
      'docs/**',
      'test/fixtures/**',
      'test/golden/**',
    ],
  },

  // ─── Base recommended rules ───────────────────────────────────────────────
  js.configs.recommended,

  // ─── Node.js plugin (ESM flat config) ─────────────────────────────────────
  pluginN.configs['flat/recommended-module'],

  // ─── Project-wide settings ────────────────────────────────────────────────
  {
    plugins: { unicorn },

    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },

    rules: {
      // ── Vanilla JS strictness ──────────────────────────────────────────────
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-shadow': 'error',
      'no-param-reassign': ['error', { props: false }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      'no-throw-literal': 'error',
      'no-return-assign': 'error',
      'no-sequences': 'error',
      'no-useless-concat': 'error',
      'no-useless-return': 'error',
      'no-lone-blocks': 'error',
      'no-multi-assign': 'error',
      'no-nested-ternary': 'error',
      'no-unneeded-ternary': 'error',
      'no-constructor-return': 'error',
      'no-promise-executor-return': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'no-unreachable-loop': 'error',

      // ── Modern JS idioms ───────────────────────────────────────────────────
      'prefer-arrow-callback': 'error',
      'arrow-body-style': ['error', 'as-needed'],
      'object-shorthand': 'error',
      'prefer-template': 'error',
      'prefer-rest-params': 'error',
      'prefer-spread': 'error',
      'prefer-exponentiation-operator': 'error',

      // ── Async best practices ───────────────────────────────────────────────
      'no-async-promise-executor': 'error',
      'no-await-in-loop': 'warn',
      'require-atomic-updates': 'error',

      // ── Imports / Node.js ──────────────────────────────────────────────────
      'n/no-missing-import': 'error',
      'n/no-extraneous-import': 'error',
      'n/no-unpublished-import': 'off', // devDeps used in tests/scripts are fine
      'n/no-process-exit': 'error', // use process.exitCode instead
      'n/prefer-node-protocol': 'error', // require node: prefix on builtins
      'n/hashbang': 'warn', // lib files may have intentional shebangs without being in bin
      'n/no-unsupported-features/node-builtins': ['error', { ignores: ['fetch'] }], // fetch used intentionally (Node 22 dev runtime)

      // ── Unicorn rules (selective) ──────────────────────────────────────────
      'unicorn/prefer-module': 'error',
      'unicorn/no-array-for-each': 'error',
      'unicorn/prefer-array-flat-map': 'error',
      'unicorn/prefer-array-index-of': 'error',
      'unicorn/prefer-includes': 'error',
      'unicorn/prefer-string-slice': 'error',
      'unicorn/prefer-string-starts-ends-with': 'error',
      'unicorn/prefer-ternary': 'warn',
      'unicorn/no-useless-undefined': 'error',
      'unicorn/no-typeof-undefined': 'error',
      'unicorn/prefer-logical-operator-over-ternary': 'error',
      'unicorn/no-negated-condition': 'warn',
      'unicorn/throw-new-error': 'error',
      'unicorn/error-message': 'error',
      'unicorn/catch-error-name': ['error', { name: 'err' }],
      'unicorn/prefer-number-properties': 'error',
      'unicorn/no-new-array': 'error',
      'unicorn/no-for-loop': 'error',
      'unicorn/prefer-at': 'error',
      'unicorn/prefer-query-selector': 'off', // Node.js context — no DOM
      'unicorn/prevent-abbreviations': 'off', // too opinionated for existing code

      // ── Console — this is a terminal tool, console is intentional ──────────
      'no-console': 'off',

      // ── Formatting concerns handled by Prettier ────────────────────────────
      'no-mixed-spaces-and-tabs': 'off',
    },
  },

  // ─── Test files — relaxed rules ───────────────────────────────────────────
  {
    files: ['test/**/*.mjs'],
    rules: {
      'no-shadow': 'off',
      'no-await-in-loop': 'off',
      'n/no-unpublished-import': 'off',
      'n/no-missing-import': 'off',
      'unicorn/no-array-for-each': 'off',
      'n/no-unsupported-features/node-builtins': ['error', { ignores: ['fetch', 'test.describe'] }], // test.describe backport ^20.13.0 not handled by eslint-plugin-n
    },
  },

  // ─── Scripts — slightly relaxed ───────────────────────────────────────────
  {
    files: ['scripts/**/*.mjs'],
    rules: {
      'n/no-unpublished-import': 'off',
    },
  },

  // ─── TypeScript files — type-aware strict rules ───────────────────────────
  ...tseslint.config({
    files: ['**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // ── Replace JS rules with TS-aware equivalents ────────────────────────
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-shadow': 'off',
      '@typescript-eslint/no-shadow': 'error',
      'no-throw-literal': 'off',
      '@typescript-eslint/only-throw-error': 'error',
      'require-await': 'off',
      '@typescript-eslint/require-await': 'error',

      // ── Type safety ───────────────────────────────────────────────────────
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',

      // ── Promise / async correctness ───────────────────────────────────────
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],

      // ── Strict boolean expressions (warn first, elevate after Phase 6) ───
      '@typescript-eslint/strict-boolean-expressions': [
        'warn',
        {
          allowString: false,
          allowNumber: false,
          allowNullableObject: true,
          allowNullableBoolean: false,
          allowNullableString: false,
          allowNullableNumber: false,
          allowAny: false,
        },
      ],

      // ── Type imports ──────────────────────────────────────────────────────
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/consistent-type-exports': 'error',

      // ── Explicit return types on exported API ─────────────────────────────
      '@typescript-eslint/explicit-module-boundary-types': 'error',

      // ── Nullish coalescing ────────────────────────────────────────────────
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',

      // ── Readonly (warn — daemon code has justified mutable state) ─────────
      '@typescript-eslint/prefer-readonly': 'warn',

      // ── Node import resolution (n plugin can't resolve .mjs from .ts context) ──
      'n/no-missing-import': 'off',

      // ── Other ─────────────────────────────────────────────────────────────
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  }),

  // ─── Test files — relax strict TS rules ──────────────────────────────────
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/strict-boolean-expressions': 'off',
      'n/no-unsupported-features/node-builtins': ['error', { ignores: ['fetch', 'test.describe', 'test.mock.module'] }],
      'no-shadow': 'off',
      'n/no-unpublished-import': 'off',
      'n/no-missing-import': 'off',
    },
  },
];
