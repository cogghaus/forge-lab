import type { NextConfig } from 'next';
import pkg from './package.json';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
};

export default nextConfig;
