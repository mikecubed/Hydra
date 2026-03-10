import js from '@eslint/js';
import pluginN from 'eslint-plugin-n';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';

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
];
