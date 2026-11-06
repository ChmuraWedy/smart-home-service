import babelParser from '@babel/eslint-parser';
import { fixupConfigRules } from '@eslint/compat';
import { FlatCompat } from '@eslint/eslintrc';
import stylistic from '@stylistic/eslint-plugin';
import { defineConfig, globalIgnores } from 'eslint/config';
import { oneJsxTagPerLine } from './eslint-rules.mjs';

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });
const airbnb = fixupConfigRules(compat.extends('airbnb', 'airbnb/hooks', 'plugin:react/jsx-runtime'));

export default defineConfig([
  globalIgnores(['src/**/*.test.{ts,tsx}', 'src/test/**']),
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [...airbnb, ...compat.env({ browser: true, es2022: true })],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          babelrc: false,
          configFile: false,
          parserOpts: { plugins: ['typescript', 'jsx'] },
        },
      },
    },
    linterOptions: { noInlineConfig: true },
    plugins: {
      '@stylistic': stylistic,
      project: { rules: { 'one-jsx-tag-per-line': oneJsxTagPerLine } },
    },
    settings: {
      react: { version: 'detect' },
      'import/resolver': { typescript: { project: `${import.meta.dirname}/tsconfig.json` } },
    },
    rules: {
      'import/extensions': ['error', 'ignorePackages', { js: 'never', jsx: 'never', ts: 'never', tsx: 'never' }],
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'react/jsx-filename-extension': ['error', { extensions: ['.tsx'] }],
      'react/prop-types': 'off',
      'react/require-default-props': 'off',
      'react/jsx-one-expression-per-line': 'off',
      'react-hooks/exhaustive-deps': 'error',
      'project/one-jsx-tag-per-line': 'error',
      'max-len': 'off',
      '@stylistic/max-len': ['error', { code: 180, ignoreComments: true, ignoreUrls: true }],
      '@stylistic/jsx-max-props-per-line': ['error', { maximum: { single: 4, multi: 1 } }],
      'no-nested-ternary': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSNonNullExpression',
          message: 'Handle missing values explicitly instead of using a non-null assertion.',
        },
        {
          selector: [
            'JSXAttribute[name.name=/^on[A-Z]/]',
            'JSXExpressionContainer',
            ':matches(ArrowFunctionExpression, FunctionExpression)',
            ':matches(ConditionalExpression, BlockStatement[body.length > 1])',
          ].join(' > '),
          message: 'Move branching or multi-step JSX event handlers into named functions.',
        },
      ],
    },
  },
]);
