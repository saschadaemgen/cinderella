// ESLint flat config (ESLint v9). See https://eslint.org/docs/latest/use/configure/
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // Lint only src/ TypeScript. Config files and build output are excluded so
    // the type-checked rules don't try to type-check files outside the TS project.
    ignores: [
      'dist/**',
      'node_modules/**',
      'media/**',
      'state/**',
      'scripts/**',
      'public/**',
      '*.js',
      '*.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  // The migration runner and startup path legitimately log to the console.
  prettier,
);
