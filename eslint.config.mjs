import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const config = [
  ...nextVitals,
  ...nextTs,
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      '.venv/**',
      '.pytest_cache/**',
      'artifacts/**',
      '.vercel/**',
      'coverage/**',
      'dist/**',
      'next-env.d.ts',
      'public/**',
    ],
  },
];

export default config;
