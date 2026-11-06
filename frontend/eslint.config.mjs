import babelParser from '@babel/eslint-parser';
import stylistic from '@stylistic/eslint-plugin';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['src/**/*.test.{ts,tsx}', 'src/test/**']),
  {
    files: ['src/**/*.{ts,tsx}'],
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
    plugins: { '@stylistic': stylistic },
    rules: {
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
