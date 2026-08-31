// Boundary enforcement only — Next.js linting handled by Biome.
// ignoreDuringBuilds: true is set in next.config.ts to prevent Next.js
// from running this config as its own lint step.
import tseslint from 'typescript-eslint';

export default tseslint.config({
  files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
  languageOptions: {
    parser: tseslint.parser,
  },
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          { group: ['../**/packages/**'], message: 'Use @tryme/* workspace imports instead' },
          { group: ['../../apps/**'], message: 'Cross-app imports are forbidden' },
        ],
      },
    ],
  },
});
